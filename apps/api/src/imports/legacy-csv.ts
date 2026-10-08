import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Anti-corruption mapping from the (synthetic) legacy extract files to Replen's canonical import records.
 * Legacy conventions handled here and nowhere else: snake_case columns, "1|4" weekday lists, empty strings for
 * nulls, "true"/"false" text booleans.
 */

/** RFC 4180 CSV: quoted fields, escaped quotes, commas inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows.filter((r) => r.length > 1 || r[0] !== "");
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const nul = (s: string) => (s === "" ? null : s);
const num = (s: string) => (s === "" ? null : Number(s));
const int = (s: string) => Number.parseInt(s, 10);
const days = (s: string) => (s ? s.split("|").map(int) : null);
const bool = (s: string) => s === "true";

export const LEGACY_FILES: { entity: string; file: string; map: (r: Record<string, string>) => Record<string, unknown> }[] = [
  {
    entity: "locations",
    file: "locations.csv",
    map: (r) => ({
      locationId: r.location_id,
      name: r.name,
      type: r.type,
      region: nul(r.region),
      servingDcId: nul(r.serving_dc_id),
      fulfilsOnline: bool(r.fulfils_online),
    }),
  },
  {
    entity: "suppliers",
    file: "suppliers.csv",
    map: (r) => ({
      supplierId: r.supplier_id,
      name: r.name,
      leadTimeDays: int(r.lead_time_days),
      leadTimeStdDays: Number(r.lead_time_std_days),
      orderWeekdays: days(r.order_weekdays) ?? [],
      deliveryWeekdays: days(r.delivery_weekdays),
      currency: r.currency,
    }),
  },
  {
    entity: "products",
    file: "products.csv",
    map: (r) => ({
      sku: r.sku,
      name: r.name,
      category: r.category,
      subcategory: r.subcategory,
      brand: r.brand,
      colourFamily: r.colour_family,
      unitPrice: Number(r.unit_price),
      status: r.status,
      launchDate: nul(r.launch_date),
      endOfLifeDate: nul(r.end_of_life_date),
    }),
  },
  {
    entity: "sourcing",
    file: "sourcing.csv",
    map: (r) => ({
      sku: r.sku,
      supplierId: r.supplier_id,
      destinationLocationId: r.destination_location_id,
      unitCost: Number(r.unit_cost),
      packSize: int(r.pack_size),
      moq: int(r.moq),
    }),
  },
  {
    entity: "item-locations",
    file: "item_locations.csv",
    map: (r) => ({
      sku: r.sku,
      locationId: r.location_id,
      replenishmentSource: r.replenishment_source,
      serviceLevel: Number(r.service_level),
      capacityUnits: num(r.capacity_units),
    }),
  },
  {
    entity: "order-constraints",
    file: "order_constraints.csv",
    map: (r) => ({
      supplierId: r.supplier_id,
      destinationLocationId: r.destination_location_id,
      minOrderValue: Number(r.min_order_value || 0),
      budget: num(r.budget),
    }),
  },
  {
    entity: "inventory-snapshots",
    file: "inventory_snapshot.csv",
    map: (r) => ({
      sku: r.sku,
      locationId: r.location_id,
      asOfDate: r.as_of_date,
      onHand: int(r.on_hand),
      reserved: int(r.reserved),
      inTransit: int(r.in_transit),
      damaged: int(r.damaged),
      returnsPending: int(r.returns_pending),
    }),
  },
  {
    entity: "open-purchase-orders",
    file: "open_purchase_orders.csv",
    map: (r) => ({
      poReference: r.po_reference,
      sku: r.sku,
      supplierId: r.supplier_id,
      destinationLocationId: r.destination_location_id,
      quantity: int(r.quantity),
      orderDate: nul(r.order_date),
      expectedDate: r.expected_date,
    }),
  },
  {
    entity: "receipt-history",
    file: "po_receipt_history.csv",
    map: (r) => ({
      poReference: r.po_reference,
      supplierId: r.supplier_id,
      destinationLocationId: r.destination_location_id,
      orderDate: r.order_date,
      promisedDate: r.promised_date,
      receivedDate: r.received_date,
      orderedUnits: int(r.ordered_units),
      receivedUnits: int(r.received_units),
    }),
  },
];

export function loadLegacyExtract(dir: string): { entity: string; records: Record<string, unknown>[] }[] {
  return LEGACY_FILES.map(({ entity, file, map }) => ({
    entity,
    records: parseCsv(readFileSync(join(dir, file), "utf8")).map(map),
  }));
}
