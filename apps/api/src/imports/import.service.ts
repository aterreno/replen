import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { unprocessable } from "../common/errors.js";
import { DB, type Db } from "../db/db.js";
import { inventorySchemas, InventoryService } from "../inventory/inventory.service.js";
import { OutboxService } from "../messaging/outbox.service.js";
import { PurchasingService, receiptHistorySchema } from "../purchasing/purchasing.service.js";
import { referenceSchemas, ReferenceService, type ReferenceEntity } from "../reference/reference.service.js";

const IMPORT_SCHEMAS: Record<string, z.ZodType> = {
  ...referenceSchemas,
  ...inventorySchemas,
  "receipt-history": receiptHistorySchema,
};
export const MAX_IMPORT_ROWS = 50_000;

/**
 * Batch import, the local stand-in for the legacy ACL feeds (A-20, A-21). Each entity is written by the module
 * that owns it, in one transaction, with an audit row and an import-completed event.
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reference: ReferenceService,
    private readonly inventory: InventoryService,
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async import(entity: string, raw: unknown, actor: string) {
    const schema = IMPORT_SCHEMAS[entity];
    if (!schema) throw unprocessable("UNKNOWN_ENTITY", `cannot import ${entity}`);
    if (!Array.isArray(raw)) throw unprocessable("VALIDATION_FAILED", "body.records must be an array");
    if (raw.length > MAX_IMPORT_ROWS) throw unprocessable("TOO_MANY_ROWS", `max ${MAX_IMPORT_ROWS} records per request`);
    const records: any[] = [];
    const issues: Record<string, unknown>[] = [];
    raw.forEach((r, i) => {
      const parsed = schema.safeParse(r);
      if (parsed.success) records.push(parsed.data);
      else if (issues.length < 20) {
        issues.push(...parsed.error.issues.map((x) => ({ row: i, path: x.path.join("."), message: x.message })));
      }
    });
    if (issues.length) throw unprocessable("VALIDATION_FAILED", `${entity}: invalid records`, issues);
    const batchId = randomUUID();
    const rows = await this.db.tx(async (q) => {
      let n: number;
      if (entity in referenceSchemas) n = await this.reference.upsert(q, entity as ReferenceEntity, records);
      else if (entity === "inventory-snapshots") n = await this.inventory.importSnapshots(q, batchId, records);
      else if (entity === "open-purchase-orders") n = await this.inventory.replaceLegacyOpenOrders(q, batchId, records);
      else n = await this.purchasing.importReceiptHistory(q, records);
      await this.audit.record(q, {
        actor,
        action: "import.completed",
        entityType: "import",
        entityId: batchId,
        metadata: { entity, rows: n },
      });
      await this.outbox.emit(q, "replen.reference.import.completed.v1", batchId, 1, { entity, rows: n, batchId });
      return n;
    });
    return { entity, rows, batchId };
  }
}
