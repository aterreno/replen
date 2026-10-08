import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { DB, type Db, type Queryable } from "../db/db.js";
import { PurchasingService } from "../purchasing/purchasing.service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const inventorySchemas = {
  "inventory-snapshots": z.object({
    sku: z.string().min(1),
    locationId: z.string().min(1),
    asOfDate: isoDate,
    onHand: z.number().int(),
    reserved: z.number().int().min(0).default(0),
    inTransit: z.number().int().min(0).default(0),
    damaged: z.number().int().min(0).default(0),
    returnsPending: z.number().int().min(0).default(0),
  }),
  "open-purchase-orders": z.object({
    poReference: z.string().min(1),
    sku: z.string().min(1),
    supplierId: z.string().min(1),
    destinationLocationId: z.string().min(1),
    quantity: z.number().int().min(0),
    orderDate: isoDate.nullish(),
    expectedDate: isoDate,
  }),
};

export interface Buckets {
  sku: string;
  locationId: string;
  asOfDate: string | null;
  onHand: number;
  reserved: number;
  inTransit: number;
  damaged: number;
  returnsPending: number;
}

export interface OpenOrderView {
  reference: string;
  quantity: number;
  expectedDate: string;
  source: "LEGACY" | "REPLEN";
}

/**
 * Unified inventory position. Physical buckets come from WMS/store snapshots (A-21); on-order combines the
 * legacy open-order extract with open Replen purchase orders read through the purchasing module.
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
  ) {}

  async importSnapshots(q: Queryable, batchId: string, records: z.infer<(typeof inventorySchemas)["inventory-snapshots"]>[]) {
    for (const r of records) {
      await q.query(
        `INSERT INTO inventory.snapshot (sku, location_id, as_of_date, on_hand, reserved, in_transit, damaged, returns_pending, import_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (sku, location_id) DO UPDATE SET as_of_date=$3, on_hand=$4, reserved=$5, in_transit=$6,
           damaged=$7, returns_pending=$8, import_batch_id=$9, imported_at=now()`,
        [r.sku, r.locationId, r.asOfDate, r.onHand, r.reserved, r.inTransit, r.damaged, r.returnsPending, batchId],
      );
    }
    return records.length;
  }

  /** Full-extract semantics: the legacy file lists every open order, so the previous set is replaced. */
  async replaceLegacyOpenOrders(
    q: Queryable,
    batchId: string,
    records: z.infer<(typeof inventorySchemas)["open-purchase-orders"]>[],
  ) {
    await q.query("DELETE FROM inventory.legacy_open_order");
    for (const r of records) {
      await q.query(
        `INSERT INTO inventory.legacy_open_order (po_reference, sku, supplier_id, destination_location_id, quantity, order_date, expected_date, import_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.poReference, r.sku, r.supplierId, r.destinationLocationId, r.quantity, r.orderDate ?? null, r.expectedDate, batchId],
      );
    }
    return records.length;
  }

  async latestSnapshotDate(): Promise<string | null> {
    const [row] = await this.db.query<{ d: string | null }>("SELECT max(as_of_date)::text AS d FROM inventory.snapshot");
    return row?.d ?? null;
  }

  async buckets(filter: { sku?: string; locationId?: string } = {}): Promise<Buckets[]> {
    const rows = await this.db.query(
      `SELECT * FROM inventory.snapshot WHERE ($1::text IS NULL OR sku = $1) AND ($2::text IS NULL OR location_id = $2)
       ORDER BY sku, location_id`,
      [filter.sku ?? null, filter.locationId ?? null],
    );
    return rows.map((r) => ({
      sku: r.sku,
      locationId: r.location_id,
      asOfDate: r.as_of_date,
      onHand: r.on_hand,
      reserved: r.reserved,
      inTransit: r.in_transit,
      damaged: r.damaged,
      returnsPending: r.returns_pending,
    }));
  }

  /** Open orders keyed by "sku|destination". */
  async openOrders(): Promise<Map<string, OpenOrderView[]>> {
    const map = new Map<string, OpenOrderView[]>();
    const add = (key: string, o: OpenOrderView) => map.set(key, [...(map.get(key) ?? []), o]);
    const legacy = await this.db.query(
      "SELECT po_reference, sku, destination_location_id, quantity, expected_date FROM inventory.legacy_open_order WHERE quantity > 0",
    );
    for (const r of legacy) {
      add(`${r.sku}|${r.destination_location_id}`, {
        reference: r.po_reference,
        quantity: r.quantity,
        expectedDate: r.expected_date,
        source: "LEGACY",
      });
    }
    for (const o of await this.purchasing.openOrderLines()) {
      add(`${o.sku}|${o.destinationLocationId}`, {
        reference: o.poNumber,
        quantity: o.openQuantity,
        expectedDate: o.expectedDate,
        source: "REPLEN",
      });
    }
    return map;
  }

  async positions(filter: { sku?: string; locationId?: string } = {}) {
    const [buckets, open] = await Promise.all([this.buckets(filter), this.openOrders()]);
    return buckets.map((b) => {
      const orders = open.get(`${b.sku}|${b.locationId}`) ?? [];
      const onOrder = orders.reduce((s, o) => s + o.quantity, 0);
      return {
        ...b,
        onOrder,
        availableToSell: Math.max(0, b.onHand - b.reserved),
        inventoryPosition: Math.max(b.onHand, 0) - b.reserved + b.inTransit + onOrder,
        openOrders: orders,
      };
    });
  }
}
