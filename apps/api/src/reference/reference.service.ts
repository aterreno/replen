import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { DB, type Db, type Queryable } from "../db/db.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const weekdays = z.array(z.number().int().min(1).max(7));

/** Canonical record shapes accepted from the legacy merchandising extract after ACL translation. */
export const referenceSchemas = {
  locations: z.object({
    locationId: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["STORE", "DC"]),
    region: z.string().nullish(),
    servingDcId: z.string().nullish(),
    fulfilsOnline: z.boolean().default(false),
  }),
  suppliers: z.object({
    supplierId: z.string().min(1),
    name: z.string().min(1),
    leadTimeDays: z.number().int().min(0),
    leadTimeStdDays: z.number().min(0).default(0),
    orderWeekdays: weekdays,
    deliveryWeekdays: weekdays.nullish(),
    currency: z.string().length(3).default("GBP"),
  }),
  products: z.object({
    sku: z.string().min(1),
    name: z.string().min(1),
    category: z.string().min(1),
    subcategory: z.string().min(1),
    brand: z.string().min(1),
    colourFamily: z.string().min(1),
    unitPrice: z.number().min(0),
    status: z.enum(["ACTIVE", "NEW", "DISCONTINUED"]),
    launchDate: isoDate.nullish(),
    endOfLifeDate: isoDate.nullish(),
  }),
  sourcing: z.object({
    sku: z.string().min(1),
    supplierId: z.string().min(1),
    destinationLocationId: z.string().min(1),
    unitCost: z.number().min(0),
    packSize: z.number().int().min(1),
    moq: z.number().int().min(0).default(0),
  }),
  "item-locations": z.object({
    sku: z.string().min(1),
    locationId: z.string().min(1),
    replenishmentSource: z.enum(["SUPPLIER", "DC_TRANSFER"]),
    serviceLevel: z.number().gt(0).lt(1),
    capacityUnits: z.number().int().min(0).nullish(),
  }),
  "order-constraints": z.object({
    supplierId: z.string().min(1),
    destinationLocationId: z.string().min(1),
    minOrderValue: z.number().min(0).default(0),
    budget: z.number().min(0).nullish(),
  }),
};

export type ReferenceEntity = keyof typeof referenceSchemas;

export interface SourcingRow {
  sku: string;
  supplierId: string;
  destinationLocationId: string;
  unitCost: number;
  packSize: number;
  moq: number;
}

export interface SupplierRow {
  supplierId: string;
  name: string;
  leadTimeDays: number;
  leadTimeStdDays: number;
  orderWeekdays: number[];
  deliveryWeekdays: number[] | null;
  currency: string;
}

export interface ProductRow {
  sku: string;
  name: string;
  category: string;
  subcategory: string;
  brand: string;
  colourFamily: string;
  unitPrice: number;
  status: "ACTIVE" | "NEW" | "DISCONTINUED";
  launchDate: string | null;
  endOfLifeDate: string | null;
}

export interface LocationRow {
  locationId: string;
  name: string;
  type: "STORE" | "DC";
  region: string | null;
  servingDcId: string | null;
  fulfilsOnline: boolean;
}

@Injectable()
export class ReferenceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async upsert(q: Queryable, entity: ReferenceEntity, records: any[]): Promise<number> {
    for (const r of records) {
      switch (entity) {
        case "locations":
          await q.query(
            `INSERT INTO reference.location (location_id, name, type, region, serving_dc_id, fulfils_online)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (location_id) DO UPDATE SET name=$2, type=$3, region=$4, serving_dc_id=$5, fulfils_online=$6, updated_at=now()`,
            [r.locationId, r.name, r.type, r.region ?? null, r.servingDcId ?? null, r.fulfilsOnline],
          );
          break;
        case "suppliers":
          await q.query(
            `INSERT INTO reference.supplier (supplier_id, name, lead_time_days, lead_time_std_days, order_weekdays, delivery_weekdays, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (supplier_id) DO UPDATE SET name=$2, lead_time_days=$3, lead_time_std_days=$4,
               order_weekdays=$5, delivery_weekdays=$6, currency=$7, updated_at=now()`,
            [r.supplierId, r.name, r.leadTimeDays, r.leadTimeStdDays, r.orderWeekdays, r.deliveryWeekdays ?? null, r.currency],
          );
          break;
        case "products":
          await q.query(
            `INSERT INTO reference.product (sku, name, category, subcategory, brand, colour_family, unit_price, status, launch_date, end_of_life_date)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (sku) DO UPDATE SET name=$2, category=$3, subcategory=$4, brand=$5, colour_family=$6,
               unit_price=$7, status=$8, launch_date=$9, end_of_life_date=$10, updated_at=now()`,
            [r.sku, r.name, r.category, r.subcategory, r.brand, r.colourFamily, r.unitPrice, r.status,
              r.launchDate ?? null, r.endOfLifeDate ?? null],
          );
          break;
        case "sourcing":
          await q.query(
            `INSERT INTO reference.sourcing (sku, supplier_id, destination_location_id, unit_cost, pack_size, moq)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (sku, destination_location_id) DO UPDATE SET supplier_id=$2, unit_cost=$4, pack_size=$5, moq=$6, updated_at=now()`,
            [r.sku, r.supplierId, r.destinationLocationId, r.unitCost, r.packSize, r.moq],
          );
          break;
        case "item-locations":
          await q.query(
            `INSERT INTO reference.item_location (sku, location_id, replenishment_source, service_level, capacity_units)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (sku, location_id) DO UPDATE SET replenishment_source=$3, service_level=$4, capacity_units=$5, updated_at=now()`,
            [r.sku, r.locationId, r.replenishmentSource, r.serviceLevel, r.capacityUnits ?? null],
          );
          break;
        case "order-constraints":
          await q.query(
            `INSERT INTO reference.order_constraint (supplier_id, destination_location_id, min_order_value, budget)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (supplier_id, destination_location_id) DO UPDATE SET min_order_value=$3, budget=$4`,
            [r.supplierId, r.destinationLocationId, r.minOrderValue, r.budget ?? null],
          );
          break;
      }
    }
    return records.length;
  }

  async suppliers(): Promise<SupplierRow[]> {
    const rows = await this.db.query(
      `SELECT supplier_id, name, lead_time_days, lead_time_std_days, order_weekdays, delivery_weekdays, currency
       FROM reference.supplier ORDER BY supplier_id`,
    );
    return rows.map((r) => ({
      supplierId: r.supplier_id,
      name: r.name,
      leadTimeDays: r.lead_time_days,
      leadTimeStdDays: r.lead_time_std_days,
      orderWeekdays: r.order_weekdays,
      deliveryWeekdays: r.delivery_weekdays,
      currency: r.currency,
    }));
  }

  async locations(): Promise<LocationRow[]> {
    const rows = await this.db.query("SELECT * FROM reference.location ORDER BY location_id");
    return rows.map((r) => ({
      locationId: r.location_id,
      name: r.name,
      type: r.type,
      region: r.region,
      servingDcId: r.serving_dc_id,
      fulfilsOnline: r.fulfils_online,
    }));
  }

  async products(skus?: string[]): Promise<ProductRow[]> {
    const rows = await this.db.query(
      "SELECT * FROM reference.product WHERE ($1::text[] IS NULL OR sku = ANY($1)) ORDER BY sku",
      [skus ?? null],
    );
    return rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      category: r.category,
      subcategory: r.subcategory,
      brand: r.brand,
      colourFamily: r.colour_family,
      unitPrice: r.unit_price,
      status: r.status,
      launchDate: r.launch_date,
      endOfLifeDate: r.end_of_life_date,
    }));
  }

  async sourcing(supplierIds?: string[]): Promise<SourcingRow[]> {
    const rows = await this.db.query(
      `SELECT * FROM reference.sourcing WHERE ($1::text[] IS NULL OR supplier_id = ANY($1))
       ORDER BY supplier_id, destination_location_id, sku`,
      [supplierIds && supplierIds.length ? supplierIds : null],
    );
    return rows.map((r) => ({
      sku: r.sku,
      supplierId: r.supplier_id,
      destinationLocationId: r.destination_location_id,
      unitCost: r.unit_cost,
      packSize: r.pack_size,
      moq: r.moq,
    }));
  }

  async itemLocations(): Promise<Map<string, { serviceLevel: number; capacityUnits: number | null }>> {
    const rows = await this.db.query("SELECT sku, location_id, service_level, capacity_units FROM reference.item_location");
    return new Map(
      rows.map((r) => [`${r.sku}|${r.location_id}`, { serviceLevel: r.service_level, capacityUnits: r.capacity_units }]),
    );
  }

  async orderConstraints(): Promise<{ supplierId: string; destinationLocationId: string; minOrderValue: number; budget: number | null }[]> {
    const rows = await this.db.query("SELECT * FROM reference.order_constraint");
    return rows.map((r) => ({
      supplierId: r.supplier_id,
      destinationLocationId: r.destination_location_id,
      minOrderValue: r.min_order_value,
      budget: r.budget,
    }));
  }
}
