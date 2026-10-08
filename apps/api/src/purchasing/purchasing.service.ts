import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { conflict, notFound } from "../common/errors.js";
import { log } from "../common/logger.js";
import { nonEmpty, round2 } from "../common/util.js";
import { CONFIG, type AppConfig } from "../config.js";
import { DB, type Db, type Queryable } from "../db/db.js";
import { OutboxService, type Envelope } from "../messaging/outbox.service.js";
import { claimInbox, EventBus } from "../messaging/relay.service.js";
import { ERP, ErpError, type ErpPort } from "./erp/erp.port.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const receiptHistorySchema = z.object({
  poReference: z.string().min(1),
  supplierId: z.string().min(1),
  destinationLocationId: z.string().min(1),
  orderDate: isoDate,
  promisedDate: isoDate,
  receivedDate: isoDate,
  orderedUnits: z.number().int().min(0),
  receivedUnits: z.number().int().min(0),
});

const OPEN_STATUSES = ["CREATED", "SUBMITTED", "SUBMISSION_FAILED", "CONFIRMED", "PARTIALLY_RECEIVED"];
const SYSTEM = "system:purchasing";

export interface PurchaseOrderView {
  poId: string;
  poNumber: string;
  sourceProposalId: string;
  supplierId: string;
  destinationLocationId: string;
  orderDate: string;
  expectedDeliveryDate: string;
  status: string;
  erpPoNumber: string | null;
  submissionAttempts: number;
  lastError: string | null;
  totalValue: number;
  currency: string;
  approvedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines: { lineNo: number; sku: string; quantity: number; unitCost: number; receivedQty: number }[];
}

@Injectable()
export class PurchasingService implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ERP) private readonly erp: ErpPort,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {}

  onModuleInit() {
    this.bus.subscribe("replen.planning.order-proposal.approved.v1", "purchasing.create-po", (e) =>
      this.createFromApproval(e),
    );
    this.bus.subscribe("replen.purchasing.purchase-order.created.v1", "purchasing.submit-po", (e) =>
      this.onCreated(e),
    );
  }

  onApplicationBootstrap() {
    if (this.config.relayIntervalMs > 0) {
      this.sweepTimer = setInterval(() => void this.retrySweep().catch(() => undefined), this.config.relayIntervalMs * 10);
    }
  }

  onApplicationShutdown() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Reacts to an approved proposal. Idempotent through the inbox and the unique source_proposal_id. */
  async createFromApproval(event: Envelope<"replen.planning.order-proposal.approved.v1">): Promise<void> {
    await this.db.tx(async (q) => {
      if (!(await claimInbox(q, "purchasing.create-po", event.id))) return;
      const d = event.data;
      const lines = d.lines.filter((l) => l.quantity > 0);
      if (lines.length === 0) return;
      const existing = await q.query("SELECT 1 FROM purchasing.purchase_order WHERE source_proposal_id = $1", [d.proposalId]);
      if (existing.length) return;
      const poId = randomUUID();
      const [{ n }] = await q.query<{ n: number }>("SELECT nextval('purchasing.po_number_seq') AS n");
      const poNumber = `RPO-${n}`;
      const total = round2(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0));
      await q.query(
        `INSERT INTO purchasing.purchase_order (po_id, po_number, source_proposal_id, supplier_id, destination_location_id,
           order_date, expected_delivery_date, currency, status, total_value, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREATED',$9,$10)`,
        [poId, poNumber, d.proposalId, d.supplierId, d.destinationLocationId, d.orderDate, d.expectedDeliveryDate,
          d.currency, total, d.approvedBy],
      );
      let lineNo = 0;
      for (const l of lines) {
        lineNo++;
        await q.query(
          "INSERT INTO purchasing.purchase_order_line (po_id, line_no, sku, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5)",
          [poId, lineNo, l.sku, l.quantity, l.unitCost],
        );
      }
      await this.audit.record(q, {
        actor: SYSTEM,
        action: "purchase-order.created",
        entityType: "purchase-order",
        entityId: poId,
        after: { poNumber, status: "CREATED", totalValue: total, lines: lines.length, sourceProposalId: d.proposalId },
        metadata: { approvedBy: d.approvedBy, causationId: event.id },
      });
      await this.outbox.emit(q, "replen.purchasing.purchase-order.created.v1", poId, 1, {
        poId,
        poNumber,
        sourceProposalId: d.proposalId,
        supplierId: d.supplierId,
        destinationLocationId: d.destinationLocationId,
        orderDate: d.orderDate,
        expectedDeliveryDate: d.expectedDeliveryDate,
        currency: d.currency,
        totalValue: total,
        approvedBy: d.approvedBy,
        lines: nonEmpty(lines.map((l, i) => ({ lineNo: i + 1, sku: l.sku, quantity: l.quantity, unitCost: l.unitCost }))),
      });
    });
  }

  private async onCreated(event: Envelope<"replen.purchasing.purchase-order.created.v1">): Promise<void> {
    const claimed = await this.db.tx((q) => claimInbox(q, "purchasing.submit-po", event.id));
    if (!claimed) return;
    // If the process stops between claim and submission, retrySweep picks up POs stuck in CREATED.
    await this.submit(event.data.poId, SYSTEM);
  }

  async submit(poId: string, actor: string): Promise<PurchaseOrderView> {
    const po = await this.get(poId);
    if (!["CREATED", "SUBMISSION_FAILED"].includes(po.status)) {
      throw conflict("PO_NOT_SUBMITTABLE", `purchase order ${po.poNumber} is ${po.status}`);
    }
    const attempt = po.submissionAttempts + 1;
    try {
      const ack = await this.erp.submitPurchaseOrder({
        poId: po.poId,
        poNumber: po.poNumber,
        supplierId: po.supplierId,
        destinationLocationId: po.destinationLocationId,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        currency: po.currency,
        lines: po.lines.map((l) => ({ lineNo: l.lineNo, sku: l.sku, quantity: l.quantity, unitCost: l.unitCost })),
      });
      await this.db.tx(async (q) => {
        const [row] = await q.query<{ version: number }>(
          `UPDATE purchasing.purchase_order SET status='SUBMITTED', erp_po_number=$2, submission_attempts=$3,
             last_error=NULL, last_error_retryable=NULL, last_attempt_at=now(), version=version+1, updated_at=now()
           WHERE po_id=$1 AND status IN ('CREATED','SUBMISSION_FAILED') RETURNING version`,
          [poId, ack.erpPoNumber, attempt],
        );
        if (!row) return;
        await this.audit.record(q, {
          actor,
          action: "purchase-order.submitted",
          entityType: "purchase-order",
          entityId: poId,
          before: { status: po.status },
          after: { status: "SUBMITTED", erpPoNumber: ack.erpPoNumber },
          metadata: { attempt, duplicateAtErp: ack.duplicate },
        });
        await this.outbox.emit(q, "replen.purchasing.purchase-order.submitted.v1", poId, row.version, {
          poId,
          poNumber: po.poNumber,
          erpPoNumber: ack.erpPoNumber,
          attempt,
          submittedAt: new Date().toISOString(),
        });
      });
    } catch (err) {
      const retryable = err instanceof ErpError ? err.retryable : true;
      const message = err instanceof Error ? err.message : String(err);
      log("warn", "ERP submission failed", { poId, attempt, retryable, error: message });
      await this.db.tx(async (q) => {
        const [row] = await q.query<{ version: number }>(
          `UPDATE purchasing.purchase_order SET status='SUBMISSION_FAILED', submission_attempts=$2, last_error=$3,
             last_error_retryable=$4, last_attempt_at=now(), version=version+1, updated_at=now()
           WHERE po_id=$1 RETURNING version`,
          [poId, attempt, message.slice(0, 500), retryable],
        );
        await this.audit.record(q, {
          actor,
          action: "purchase-order.submission-failed",
          entityType: "purchase-order",
          entityId: poId,
          before: { status: po.status },
          after: { status: "SUBMISSION_FAILED" },
          metadata: { attempt, retryable, error: message },
        });
        await this.outbox.emit(q, "replen.purchasing.purchase-order.submission-failed.v1", poId, row.version, {
          poId,
          poNumber: po.poNumber,
          attempt,
          error: message.slice(0, 500),
          retryable,
        });
      });
    }
    return this.get(poId);
  }

  async retry(poId: string, actor: string): Promise<PurchaseOrderView> {
    const po = await this.get(poId);
    if (po.status !== "SUBMISSION_FAILED") throw conflict("PO_NOT_FAILED", `purchase order ${po.poNumber} is ${po.status}`);
    return this.submit(poId, actor);
  }

  /** Automatic retry with exponential backoff for retryable failures, and recovery of POs stuck in CREATED. */
  async retrySweep(): Promise<number> {
    const due = await this.db.query<{ po_id: string }>(
      `SELECT po_id FROM purchasing.purchase_order
       WHERE (status = 'SUBMISSION_FAILED' AND last_error_retryable AND submission_attempts < $1
              AND last_attempt_at < now() - make_interval(secs => 5 * power(2, submission_attempts)))
          OR (status = 'CREATED' AND created_at < now() - interval '60 seconds')
       ORDER BY created_at LIMIT 20`,
      [this.config.erpMaxAttempts],
    );
    for (const { po_id } of due) await this.submit(po_id, SYSTEM).catch(() => undefined);
    return due.length;
  }

  private async load(where: string, params: unknown[]): Promise<PurchaseOrderView[]> {
    const headers = await this.db.query(`SELECT * FROM purchasing.purchase_order ${where}`, params);
    if (headers.length === 0) return [];
    const lines = await this.db.query(
      "SELECT * FROM purchasing.purchase_order_line WHERE po_id = ANY($1::uuid[]) ORDER BY line_no",
      [headers.map((h) => h.po_id)],
    );
    return headers.map((h) => ({
      poId: h.po_id,
      poNumber: h.po_number,
      sourceProposalId: h.source_proposal_id,
      supplierId: h.supplier_id,
      destinationLocationId: h.destination_location_id,
      orderDate: h.order_date,
      expectedDeliveryDate: h.expected_delivery_date,
      status: h.status,
      erpPoNumber: h.erp_po_number,
      submissionAttempts: h.submission_attempts,
      lastError: h.last_error,
      totalValue: h.total_value,
      currency: h.currency.trim(),
      approvedBy: h.approved_by,
      version: h.version,
      createdAt: h.created_at,
      updatedAt: h.updated_at,
      lines: lines
        .filter((l) => l.po_id === h.po_id)
        .map((l) => ({ lineNo: l.line_no, sku: l.sku, quantity: l.quantity, unitCost: l.unit_cost, receivedQty: l.received_qty })),
    }));
  }

  async list(): Promise<PurchaseOrderView[]> {
    return this.load("ORDER BY created_at DESC LIMIT 200", []);
  }

  async get(poId: string): Promise<PurchaseOrderView> {
    const [po] = await this.load("WHERE po_id = $1", [poId]);
    if (!po) throw notFound("purchase order", poId);
    return po;
  }

  async forProposals(proposalIds: string[]): Promise<Map<string, PurchaseOrderView>> {
    if (proposalIds.length === 0) return new Map();
    const pos = await this.load("WHERE source_proposal_id = ANY($1::uuid[])", [proposalIds]);
    return new Map(pos.map((p) => [p.sourceProposalId, p]));
  }

  async openOrderLines() {
    const rows = await this.db.query(
      `SELECT h.po_number, h.destination_location_id, h.expected_delivery_date, l.sku, l.quantity - l.received_qty AS open_qty
       FROM purchasing.purchase_order h JOIN purchasing.purchase_order_line l USING (po_id)
       WHERE h.status = ANY($1) AND l.quantity > l.received_qty`,
      [OPEN_STATUSES],
    );
    return rows.map((r) => ({
      poNumber: r.po_number as string,
      destinationLocationId: r.destination_location_id as string,
      expectedDate: r.expected_delivery_date as string,
      sku: r.sku as string,
      openQuantity: r.open_qty as number,
    }));
  }

  async importReceiptHistory(q: Queryable, records: z.infer<typeof receiptHistorySchema>[]) {
    for (const r of records) {
      await q.query(
        `INSERT INTO purchasing.receipt_history (po_reference, supplier_id, destination_location_id, order_date, promised_date, received_date, ordered_units, received_units)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (po_reference) DO UPDATE SET supplier_id=$2, destination_location_id=$3, order_date=$4,
           promised_date=$5, received_date=$6, ordered_units=$7, received_units=$8`,
        [r.poReference, r.supplierId, r.destinationLocationId, r.orderDate, r.promisedDate, r.receivedDate, r.orderedUnits, r.receivedUnits],
      );
    }
    return records.length;
  }

  /** OTIF = share of deliveries received on or before the promised date and in full. */
  async otifBySupplier(): Promise<Map<string, { otif: number; onTime: number; inFull: number; deliveries: number }>> {
    const rows = await this.db.query(
      `SELECT supplier_id,
              count(*) AS deliveries,
              avg(CASE WHEN received_date <= promised_date THEN 1.0 ELSE 0.0 END) AS on_time,
              avg(CASE WHEN received_units >= ordered_units THEN 1.0 ELSE 0.0 END) AS in_full,
              avg(CASE WHEN received_date <= promised_date AND received_units >= ordered_units THEN 1.0 ELSE 0.0 END) AS otif
       FROM purchasing.receipt_history GROUP BY supplier_id`,
    );
    return new Map(
      rows.map((r) => [
        r.supplier_id,
        { otif: Number(r.otif), onTime: Number(r.on_time), inFull: Number(r.in_full), deliveries: Number(r.deliveries) },
      ]),
    );
  }
}
