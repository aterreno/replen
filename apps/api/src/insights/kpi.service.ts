import { Inject, Injectable } from "@nestjs/common";
import { round2 } from "../common/util.js";
import { DB, type Db } from "../db/db.js";
import { PurchasingService } from "../purchasing/purchasing.service.js";

interface Kpi {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  definition: string;
  source: string;
  breakdown?: Record<string, unknown>[];
}

const r4 = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10000) / 10000);

/**
 * KPI read model. The one place that reads across module schemas, through read-only queries
 * (documented exception in doc 04). Every KPI carries its definition and data source.
 */
@Injectable()
export class KpiService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
  ) {}

  async snapshot() {
    const [run] = await this.db.query(
      `SELECT run_id, as_of_date, accuracy FROM planning.planning_run WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1`,
    );
    const lines = run
      ? await this.db.query(
          `SELECT l.sku, l.avg_daily_forecast, l.exception_codes, l.accuracy, l.unit_cost, l.recommended_qty, l.final_qty,
                  p.unit_price
           FROM planning.proposal_line l JOIN planning.order_proposal o USING (proposal_id)
           JOIN reference.product p ON p.sku = l.sku WHERE o.run_id = $1`,
          [run.run_id],
        )
      : [];

    const [avail] = await this.db.query(
      `SELECT
         avg(CASE WHEN s.on_hand - s.reserved > 0 THEN 1.0 ELSE 0.0 END) AS all_rate,
         avg(CASE WHEN s.on_hand - s.reserved > 0 THEN 1.0 ELSE 0.0 END) FILTER (WHERE loc.type = 'STORE') AS store_rate,
         avg(CASE WHEN s.on_hand - s.reserved > 0 THEN 1.0 ELSE 0.0 END) FILTER (WHERE loc.type = 'DC') AS dc_rate,
         count(*) AS n
       FROM inventory.snapshot s
       JOIN reference.product p ON p.sku = s.sku
       JOIN reference.location loc ON loc.location_id = s.location_id
       WHERE p.status <> 'DISCONTINUED' AND (p.launch_date IS NULL OR p.launch_date <= s.as_of_date)`,
    );
    const [stock] = await this.db.query(
      `SELECT coalesce(sum(greatest(s.on_hand, 0) * src.unit_cost), 0) AS value,
              coalesce(sum(greatest(s.on_hand, 0) * src.unit_cost) FILTER (WHERE loc.type = 'DC'), 0) AS dc_value,
              coalesce(sum(greatest(s.on_hand, 0)) FILTER (WHERE loc.type = 'DC'), 0) AS dc_units
       FROM inventory.snapshot s
       JOIN reference.sourcing src ON src.sku = s.sku
       JOIN reference.location loc ON loc.location_id = s.location_id`,
    );
    const [legacyOnOrder] = await this.db.query(
      `SELECT coalesce(sum(o.quantity * src.unit_cost), 0) AS value FROM inventory.legacy_open_order o
       JOIN reference.sourcing src ON src.sku = o.sku AND src.destination_location_id = o.destination_location_id`,
    );
    const [replenPo] = await this.db.query(
      `SELECT coalesce(sum(total_value) FILTER (WHERE status IN ('CREATED','SUBMITTED','SUBMISSION_FAILED','CONFIRMED','PARTIALLY_RECEIVED')), 0) AS open_value,
              count(*) FILTER (WHERE status = 'SUBMITTED') AS submitted,
              count(*) FILTER (WHERE status = 'SUBMISSION_FAILED') AS failed,
              coalesce(sum(total_value) FILTER (WHERE status = 'SUBMITTED'), 0) AS submitted_value
       FROM purchasing.purchase_order`,
    );
    const [planner] = await this.db.query(
      `SELECT
         count(*) FILTER (WHERE status IN ('PROPOSED','AWAITING_APPROVAL')) AS open_proposals,
         avg(extract(epoch FROM decided_at - created_at) / 3600.0) FILTER (WHERE status = 'APPROVED') AS cycle_hours
       FROM planning.order_proposal`,
    );
    const [overrides] = await this.db.query(
      `SELECT count(*) FILTER (WHERE l.final_qty <> l.recommended_qty) AS changed,
              count(*) AS decided_lines,
              count(*) FILTER (WHERE l.severity = 'blocking' AND l.overridden_by IS NULL AND o.status IN ('PROPOSED','AWAITING_APPROVAL')) AS open_blocking
       FROM planning.proposal_line l JOIN planning.order_proposal o USING (proposal_id)
       WHERE o.status IN ('APPROVED','REJECTED','PROPOSED','AWAITING_APPROVAL')`,
    );

    const totalDaily = lines.reduce((s, l) => s + Number(l.avg_daily_forecast), 0);
    const annualCogs = lines.reduce((s, l) => s + Number(l.avg_daily_forecast) * 365 * Number(l.unit_cost), 0);
    const lostUnits = lines.reduce((s, l) => s + Number(l.accuracy?.lostUnitsEstimate ?? 0), 0);
    const lostValue = lines.reduce((s, l) => s + Number(l.accuracy?.lostUnitsEstimate ?? 0) * Number(l.unit_price), 0);
    const atRisk = lines.filter((l) => (l.exception_codes as string[]).includes("PROJECTED_STOCKOUT_BEFORE_ARRIVAL")).length;
    const otif = await this.purchasing.otifBySupplier();
    const otifAll = [...otif.values()];
    const deliveries = otifAll.reduce((s, o) => s + o.deliveries, 0);
    const accuracy = run?.accuracy ?? {};

    const groups: { group: string; kpis: Kpi[] }[] = [
      {
        group: "Availability",
        kpis: [
          {
            key: "in_stock_rate",
            label: "In-stock rate",
            value: r4(avail?.all_rate),
            unit: "ratio",
            definition: "Share of ranged, non-discontinued SKU-locations with on-hand minus reserved > 0 at the snapshot date",
            source: "inventory.snapshot (latest import)",
            breakdown: [
              { label: "Stores", value: r4(avail?.store_rate), unit: "ratio" },
              { label: "DC", value: r4(avail?.dc_rate), unit: "ratio" },
            ],
          },
          {
            key: "lines_at_risk",
            label: "Lines projected to stock out before delivery",
            value: run ? atRisk : null,
            unit: "count",
            definition: "Proposal lines in the latest run whose projected stock (no new order) runs out before the order can arrive",
            source: "latest planning run, PROJECTED_STOCKOUT_BEFORE_ARRIVAL exceptions",
          },
          {
            key: "lost_sales",
            label: "Estimated lost sales (last 28 days)",
            value: run ? round2(lostValue) : null,
            unit: "GBP",
            definition: "Forecast demand on out-of-stock days in the 28-day backtest window, valued at selling price",
            source: "engine backtest (censored days) in latest run",
            breakdown: [{ label: "Units", value: Math.round(lostUnits), unit: "count" }],
          },
        ],
      },
      {
        group: "Forecast quality",
        kpis: [
          {
            key: "wape",
            label: "WAPE (28-day backtest)",
            value: r4(accuracy.wape),
            unit: "ratio",
            definition: "sum |forecast - actual| / sum actual over the last 28 days, DC demand aggregated per SKU, in-stock days only",
            source: "engine backtest in latest run",
          },
          {
            key: "bias",
            label: "Forecast bias",
            value: r4(accuracy.bias),
            unit: "ratio",
            definition: "sum (forecast - actual) / sum actual; positive means over-forecast",
            source: "engine backtest in latest run",
          },
          {
            key: "forecast_value_added",
            label: "Forecast value added vs seasonal naive",
            value: accuracy.wape != null && accuracy.naiveWape ? r4(1 - accuracy.wape / accuracy.naiveWape) : null,
            unit: "ratio",
            definition: "1 - WAPE(model) / WAPE(repeat last week). Above 0 means the model beats the naive benchmark",
            source: "engine backtest in latest run",
            breakdown: [{ label: "Naive WAPE", value: r4(accuracy.naiveWape), unit: "ratio" }],
          },
        ],
      },
      {
        group: "Inventory and working capital",
        kpis: [
          {
            key: "stock_value",
            label: "Stock holding at cost",
            value: round2(Number(stock.value)),
            unit: "GBP",
            definition: "sum max(on-hand, 0) x unit cost across stores and DCs",
            source: "inventory.snapshot x reference.sourcing",
            breakdown: [{ label: "DC", value: round2(Number(stock.dc_value)), unit: "GBP" }],
          },
          {
            key: "days_of_supply",
            label: "DC days of supply",
            value: totalDaily > 0 ? round2(Number(stock.dc_units) / totalDaily) : null,
            unit: "days",
            definition: "DC on-hand units / total forecast daily demand served by the DC",
            source: "inventory.snapshot, latest run forecasts",
          },
          {
            key: "inventory_turns",
            label: "Inventory turns (forward-looking)",
            value: Number(stock.value) > 0 && run ? round2(annualCogs / Number(stock.value)) : null,
            unit: "per year",
            definition: "forecast annual demand at cost / stock holding at cost. Uses forecast, not trailing sales",
            source: "latest run forecasts, inventory.snapshot",
          },
          {
            key: "working_capital",
            label: "Working capital in stock and on order",
            value: round2(Number(stock.value) + Number(legacyOnOrder.value) + Number(replenPo.open_value)),
            unit: "GBP",
            definition: "stock holding at cost + legacy open orders at cost + open Replen purchase orders",
            source: "inventory, purchasing",
            breakdown: [
              { label: "Legacy on order", value: round2(Number(legacyOnOrder.value)), unit: "GBP" },
              { label: "Replen POs open", value: round2(Number(replenPo.open_value)), unit: "GBP" },
            ],
          },
        ],
      },
      {
        group: "Suppliers",
        kpis: [
          {
            key: "supplier_otif",
            label: "Supplier OTIF",
            value: deliveries ? r4(otifAll.reduce((s, o) => s + o.otif * o.deliveries, 0) / deliveries) : null,
            unit: "ratio",
            definition: "Deliveries received on or before the promised date and in full / all deliveries",
            source: "purchasing.receipt_history (synthetic legacy history)",
            breakdown: [...otif.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([supplierId, o]) => ({ label: supplierId, value: r4(o.otif), unit: "ratio", deliveries: o.deliveries })),
          },
        ],
      },
      {
        group: "Planner workflow",
        kpis: [
          {
            key: "open_proposals",
            label: "Open proposals",
            value: Number(planner.open_proposals),
            unit: "count",
            definition: "Proposals in PROPOSED or AWAITING_APPROVAL",
            source: "planning.order_proposal",
            breakdown: [{ label: "Unresolved blocking lines", value: Number(overrides.open_blocking), unit: "count" }],
          },
          {
            key: "override_rate",
            label: "Override rate",
            value: Number(overrides.decided_lines) ? r4(Number(overrides.changed) / Number(overrides.decided_lines)) : null,
            unit: "ratio",
            definition: "Lines where the planner's final quantity differs from the recommendation / all lines",
            source: "planning.proposal_line",
          },
          {
            key: "approval_cycle_time",
            label: "Approval cycle time",
            value: planner.cycle_hours === null ? null : round2(Number(planner.cycle_hours)),
            unit: "hours",
            definition: "Average time from proposal creation to approval",
            source: "planning.order_proposal",
          },
          {
            key: "pos_submitted",
            label: "POs accepted by ERP",
            value: Number(replenPo.submitted),
            unit: "count",
            definition: "Purchase orders acknowledged by the ERP (mock in the slice)",
            source: "purchasing.purchase_order",
            breakdown: [
              { label: "Value", value: round2(Number(replenPo.submitted_value)), unit: "GBP" },
              { label: "Failed submissions", value: Number(replenPo.failed), unit: "count" },
            ],
          },
        ],
      },
    ];
    return { generatedAt: new Date().toISOString(), asOfDate: run?.as_of_date ?? null, synthetic: true, groups };
  }
}
