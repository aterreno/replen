import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { AuditService } from "./audit/audit.service.js";
import { DomainError, unprocessable } from "./common/errors.js";
import { CONFIG, type AppConfig } from "./config.js";
import { DB, type Db } from "./db/db.js";
import { currentUser, Public, Roles } from "./identity/identity.js";
import { KpiService } from "./insights/kpi.service.js";
import { inventorySchemas, InventoryService } from "./inventory/inventory.service.js";
import { OutboxService } from "./messaging/outbox.service.js";
import { ENGINE, type EngineClient } from "./planning/engine.client.js";
import { ERP, type ErpPort } from "./purchasing/erp/erp.port.js";
import { PurchasingService, receiptHistorySchema } from "./purchasing/purchasing.service.js";
import { referenceSchemas, ReferenceService, type ReferenceEntity } from "./reference/reference.service.js";

const IMPORT_SCHEMAS: Record<string, z.ZodType> = {
  ...referenceSchemas,
  ...inventorySchemas,
  "receipt-history": receiptHistorySchema,
};
const MAX_IMPORT_ROWS = 50_000;

/**
 * Batch import endpoint: the local stand-in for the legacy ACL feeds (A-20, A-21). Each entity is written by
 * the module that owns it, in one transaction, with an audit row and an import-completed event.
 */
@Controller("api/v1/imports")
export class ImportsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reference: ReferenceService,
    private readonly inventory: InventoryService,
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  @Post(":entity")
  @HttpCode(200)
  @Roles("admin")
  async import(@Param("entity") entity: string, @Body() body: { records?: unknown[] }, @Req() req: Request) {
    const schema = IMPORT_SCHEMAS[entity];
    if (!schema) throw unprocessable("UNKNOWN_ENTITY", `cannot import ${entity}`);
    const raw = body?.records;
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
    const user = currentUser(req);
    const batchId = randomUUID();
    const rows = await this.db.tx(async (q) => {
      let n: number;
      if (entity in referenceSchemas) n = await this.reference.upsert(q, entity as ReferenceEntity, records);
      else if (entity === "inventory-snapshots") n = await this.inventory.importSnapshots(q, batchId, records);
      else if (entity === "open-purchase-orders") n = await this.inventory.replaceLegacyOpenOrders(q, batchId, records);
      else n = await this.purchasing.importReceiptHistory(q, records);
      await this.audit.record(q, {
        actor: user.userId,
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

@Controller("api/v1")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get("inventory-positions")
  positions(@Query("sku") sku?: string, @Query("locationId") locationId?: string) {
    return this.inventory.positions({ sku, locationId });
  }
}

@Controller("api/v1/purchase-orders")
export class PurchasingController {
  constructor(@Inject(PurchasingService) private readonly purchasing: PurchasingService) {}

  @Get()
  list() {
    return this.purchasing.list();
  }

  @Get(":poId")
  get(@Param("poId", ParseUUIDPipe) poId: string) {
    return this.purchasing.get(poId);
  }

  @Post(":poId/retry-submission")
  @HttpCode(200)
  @Roles("planner", "senior_planner", "head_of_replenishment", "admin")
  retry(@Param("poId", ParseUUIDPipe) poId: string, @Req() req: Request) {
    return this.purchasing.retry(poId, currentUser(req).userId);
  }
}

@Controller("api/v1/audit-events")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query("entityType") entityType?: string, @Query("entityId") entityId?: string, @Query("limit") limit?: string) {
    return this.audit.list({ entityType, entityId, limit: limit ? Number(limit) : undefined });
  }

  @Get("verify")
  verify() {
    return this.audit.verify();
  }
}

@Controller("api/v1/kpis")
export class KpiController {
  constructor(private readonly kpis: KpiService) {}

  @Get()
  get() {
    return this.kpis.snapshot();
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENGINE) private readonly engine: EngineClient,
    @Inject(ERP) private readonly erp: ErpPort,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get("health")
  async health() {
    let database = "ok";
    try {
      await this.db.query("SELECT 1");
    } catch {
      database = "unavailable";
    }
    const [engine, erp] = await Promise.all([this.engine.health(), this.erp.health()]);
    if (database !== "ok") throw new DomainError("DB_UNAVAILABLE", 503, "database unavailable");
    return {
      status: engine === "ok" && erp === "ok" ? "ok" : "degraded",
      version: "0.1.0",
      database: `${database} (${this.db.kind})`,
      engine,
      erp,
      authMode: this.config.authMode,
    };
  }
}
