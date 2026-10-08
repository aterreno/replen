import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { PlanRequest, PlanResponse } from "@replen/contracts";
import { AuditService } from "../audit/audit.service.js";
import { DomainError, notFound, unprocessable } from "../common/errors.js";
import { log } from "../common/logger.js";
import { canonicalJson, nonEmpty, round2, sha256 } from "../common/util.js";
import { DB, type Db, type Queryable } from "../db/db.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ContractValidator } from "../messaging/contracts.js";
import { OutboxService } from "../messaging/outbox.service.js";
import { ReferenceService } from "../reference/reference.service.js";
import { ENGINE, type EngineClient } from "./engine.client.js";
import { maxSeverity, POLICY_DEFAULTS } from "./rules.js";

type PlanItem = PlanRequest["items"][number];
type ItemResult = PlanResponse["items"][number];

export interface RunRequest {
  asOfDate?: string;
  supplierIds?: string[];
}

export interface PlanningRunView {
  runId: string;
  asOfDate: string;
  status: string;
  requestedBy: string;
  engineVersion: string | null;
  contractVersion: string | null;
  accuracy: Record<string, unknown> | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

@Injectable()
export class PlanningService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENGINE) private readonly engine: EngineClient,
    private readonly reference: ReferenceService,
    private readonly inventory: InventoryService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly validator: ContractValidator,
  ) {}

  /** Freeze inputs from the transactional model into an engine request (contract v1). */
  async buildRequest(runId: string, asOfDate: string, supplierIds?: string[]): Promise<{ request: PlanRequest; skipped: string[] }> {
    const [sourcing, suppliers, products, locations, itemLocs, buckets, openOrders, constraints] = await Promise.all([
      this.reference.sourcing(supplierIds),
      this.reference.suppliers(),
      this.reference.products(),
      this.reference.locations(),
      this.reference.itemLocations(),
      this.inventory.buckets(),
      this.inventory.openOrders(),
      this.reference.orderConstraints(),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.supplierId, s]));
    const productBySku = new Map(products.map((p) => [p.sku, p]));
    const bucketByKey = new Map(buckets.map((b) => [`${b.sku}|${b.locationId}`, b]));
    const skipped: string[] = [];
    const items: PlanItem[] = [];
    for (const s of sourcing) {
      const product = productBySku.get(s.sku);
      const supplier = supplierById.get(s.supplierId);
      const dest = locations.find((l) => l.locationId === s.destinationLocationId);
      if (!product || !supplier || !dest) {
        skipped.push(`${s.sku}@${s.destinationLocationId}: missing reference data`);
        continue;
      }
      const demandSources: { locationId: string; channel: "store" | "online" }[] = locations
        .filter((l) => l.type === "STORE" && l.servingDcId === dest.locationId)
        .map((l) => ({ locationId: l.locationId, channel: "store" as const }));
      if (dest.fulfilsOnline) demandSources.push({ locationId: dest.locationId, channel: "online" });
      if (dest.type === "STORE") demandSources.push({ locationId: dest.locationId, channel: "store" });
      if (demandSources.length === 0) {
        skipped.push(`${s.sku}@${s.destinationLocationId}: no demand sources`);
        continue;
      }
      const il = itemLocs.get(`${s.sku}|${dest.locationId}`);
      const b = bucketByKey.get(`${s.sku}|${dest.locationId}`);
      items.push({
        sku: s.sku,
        destinationLocationId: dest.locationId,
        unitPrice: product.unitPrice,
        demandSources: nonEmpty(demandSources),
        sourcing: {
          supplierId: s.supplierId,
          leadTimeDays: supplier.leadTimeDays,
          leadTimeStdDays: supplier.leadTimeStdDays,
          orderWeekdays: supplier.orderWeekdays,
          deliveryWeekdays: supplier.deliveryWeekdays,
          moq: s.moq,
          packSize: s.packSize,
          unitCost: s.unitCost,
        },
        lifecycle: { status: product.status, launchDate: product.launchDate, endOfLifeDate: product.endOfLifeDate },
        policy: {
          serviceLevel: il?.serviceLevel ?? POLICY_DEFAULTS.serviceLevel,
          maxMoqCoverDays: POLICY_DEFAULTS.maxMoqCoverDays,
          packRoundUpThreshold: POLICY_DEFAULTS.packRoundUpThreshold,
          overdueGraceDays: POLICY_DEFAULTS.overdueGraceDays,
          capacityUnits: il?.capacityUnits ?? null,
        },
        inventory: {
          onHand: b?.onHand ?? 0,
          reserved: b?.reserved ?? 0,
          inTransit: b?.inTransit ?? 0,
          damaged: b?.damaged ?? 0,
          returnsPending: b?.returnsPending ?? 0,
        },
        openOrders: (openOrders.get(`${s.sku}|${dest.locationId}`) ?? []).map((o) => ({
          reference: o.reference,
          quantity: o.quantity,
          expectedDate: o.expectedDate,
        })),
      });
    }
    const inScope = new Set(items.map((i) => `${i.sourcing.supplierId}|${i.destinationLocationId}`));
    const request: PlanRequest = {
      contractVersion: "1.0.0",
      runId,
      asOfDate,
      historyDays: 730,
      backtestDays: 28,
      persist: true,
      items,
      orderConstraints: constraints
        .filter((c) => inScope.has(`${c.supplierId}|${c.destinationLocationId}`))
        .map((c) => ({
          supplierId: c.supplierId,
          destinationLocationId: c.destinationLocationId,
          minOrderValue: c.minOrderValue,
          budget: c.budget,
        })),
    };
    return { request, skipped };
  }

  async run(actor: string, req: RunRequest): Promise<PlanningRunView> {
    const asOfDate = req.asOfDate ?? (await this.inventory.latestSnapshotDate());
    if (!asOfDate) throw unprocessable("NO_INVENTORY", "No inventory snapshot imported; cannot plan");
    const runId = randomUUID();
    const scope = { supplierIds: req.supplierIds ?? null };
    await this.db.tx(async (q) => {
      await q.query(
        "INSERT INTO planning.planning_run (run_id, as_of_date, status, scope, requested_by) VALUES ($1,$2,'RUNNING',$3::jsonb,$4)",
        [runId, asOfDate, JSON.stringify(scope), actor],
      );
      await this.audit.record(q, {
        actor,
        action: "planning-run.started",
        entityType: "planning-run",
        entityId: runId,
        after: { asOfDate, scope },
      });
    });

    const started = Date.now();
    let response: PlanResponse;
    let request: PlanRequest;
    let skipped: string[];
    try {
      ({ request, skipped } = await this.buildRequest(runId, asOfDate, req.supplierIds));
      if (request.items.length === 0) throw unprocessable("EMPTY_SCOPE", "No items in scope");
      const check = this.validator.validateEngine("plan-request", request);
      if (!check.valid) throw new Error(`plan request violates contract: ${check.errors.join("; ")}`);
      response = await this.engine.plan(request);
      const resCheck = this.validator.validateEngine("plan-response", response);
      if (!resCheck.valid) {
        throw new DomainError("ENGINE_CONTRACT", 502, `engine response violates contract: ${resCheck.errors.slice(0, 5).join("; ")}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db.tx(async (q) => {
        await q.query(
          "UPDATE planning.planning_run SET status='FAILED', error=$2, completed_at=now() WHERE run_id=$1",
          [runId, message.slice(0, 2000)],
        );
        await this.audit.record(q, {
          actor,
          action: "planning-run.failed",
          entityType: "planning-run",
          entityId: runId,
          metadata: { error: message.slice(0, 500) },
        });
      });
      log("error", "planning run failed", { runId, error: message });
      throw err instanceof DomainError ? err : new DomainError("PLANNING_FAILED", 502, message);
    }

    await this.db.tx((q) => this.persist(q, actor, request, response, skipped, Date.now() - started));
    return this.get(runId);
  }

  private async persist(
    q: Queryable,
    actor: string,
    request: PlanRequest,
    response: PlanResponse,
    skipped: string[],
    durationMs: number,
  ) {
    const runId = request.runId;
    const scopeKeys = new Set(request.items.map((i) => `${i.sourcing.supplierId}|${i.destinationLocationId}`));
    const open = await q.query<{ proposal_id: string; supplier_id: string; destination_location_id: string; version: number }>(
      "SELECT proposal_id, supplier_id, destination_location_id, version FROM planning.order_proposal WHERE status IN ('PROPOSED','AWAITING_APPROVAL') FOR UPDATE",
    );
    for (const p of open.filter((o) => scopeKeys.has(`${o.supplier_id}|${o.destination_location_id}`))) {
      await q.query(
        "UPDATE planning.order_proposal SET status='SUPERSEDED', version=version+1, updated_at=now() WHERE proposal_id=$1",
        [p.proposal_id],
      );
      await this.audit.record(q, {
        actor,
        action: "order-proposal.superseded",
        entityType: "order-proposal",
        entityId: p.proposal_id,
        metadata: { supersededByRunId: runId },
      });
      await this.outbox.emit(q, "replen.planning.order-proposal.superseded.v1", p.proposal_id, p.version + 1, {
        proposalId: p.proposal_id,
        supersededByRunId: runId,
      });
    }

    const itemsByOrder = new Map<string, ItemResult[]>();
    for (const item of response.items) {
      const key = `${item.supplierId}|${item.destinationLocationId}|${item.orderDate}`;
      itemsByOrder.set(key, [...(itemsByOrder.get(key) ?? []), item]);
    }
    const reqItem = new Map(request.items.map((i) => [`${i.sku}|${i.destinationLocationId}`, i]));
    let lineCount = 0;
    for (const order of response.orders) {
      const items = itemsByOrder.get(`${order.supplierId}|${order.destinationLocationId}|${order.orderDate}`) ?? [];
      if (items.length === 0) continue;
      const proposalId = randomUUID();
      const recommendedValue = round2(
        items.reduce((s, i) => s + i.recommendedQty * reqItem.get(`${i.sku}|${i.destinationLocationId}`)!.sourcing.unitCost, 0),
      );
      const severities = items.map((i) => maxSeverity(i.explanation.exceptions.map((e) => e.severity)));
      const blocking = severities.filter((s) => s === "blocking").length;
      const warning = severities.filter((s) => s === "warning").length + order.exceptions.length;
      await q.query(
        `INSERT INTO planning.order_proposal (proposal_id, run_id, supplier_id, destination_location_id, order_date,
           expected_delivery_date, status, recommended_value, solver_status, notes, order_exceptions)
         VALUES ($1,$2,$3,$4,$5,$6,'PROPOSED',$7,$8,$9::jsonb,$10::jsonb)`,
        [proposalId, runId, order.supplierId, order.destinationLocationId, order.orderDate, order.expectedDeliveryDate,
          recommendedValue, order.solverStatus, JSON.stringify(order.notes), JSON.stringify(order.exceptions)],
      );
      for (const [idx, item] of items.entries()) {
        const ri = reqItem.get(`${item.sku}|${item.destinationLocationId}`)!;
        await q.query(
          `INSERT INTO planning.proposal_line (line_id, proposal_id, sku, unit_cost, pack_size, moq, recommended_qty, final_qty,
             forecast_over_period, order_up_to, safety_stock, inventory_position, protection_period_days,
             days_of_supply_after_order, projected_stockout_date, avg_daily_forecast, severity, exception_codes,
             explanation, chart, accuracy)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb)`,
          [randomUUID(), proposalId, item.sku, ri.sourcing.unitCost, ri.sourcing.packSize, ri.sourcing.moq ?? 0,
            item.recommendedQty, item.forecastOverPeriod, item.orderUpTo, item.safetyStock, item.inventoryPosition,
            item.protectionPeriodDays, item.daysOfSupplyAfterOrder ?? null, item.projectedStockoutDate ?? null,
            item.avgDailyForecast, severities[idx], item.explanation.exceptions.map((e) => e.code),
            JSON.stringify(item.explanation),
            JSON.stringify({ history: item.history, forecast: item.forecast, projection: item.projection }),
            JSON.stringify(item.accuracy ?? null)],
        );
        lineCount++;
      }
      await this.audit.record(q, {
        actor: "system:planning",
        action: "order-proposal.created",
        entityType: "order-proposal",
        entityId: proposalId,
        after: { supplierId: order.supplierId, lines: items.length, recommendedValue, blocking },
        metadata: { runId },
      });
      await this.outbox.emit(q, "replen.planning.order-proposal.created.v1", proposalId, 1, {
        proposalId,
        runId,
        supplierId: order.supplierId,
        destinationLocationId: order.destinationLocationId,
        orderDate: order.orderDate,
        expectedDeliveryDate: order.expectedDeliveryDate,
        lineCount: items.length,
        recommendedValue,
        currency: "GBP",
        blockingCount: blocking,
        warningCount: warning,
      });
    }
    const accuracy = {
      wape: response.accuracy.wape ?? null,
      bias: response.accuracy.bias ?? null,
      naiveWape: response.accuracy.naiveWape ?? null,
      seriesEvaluated: response.accuracy.seriesEvaluated,
    };
    const stats = {
      items: request.items.length,
      proposals: response.orders.length,
      lines: lineCount,
      skipped,
      durationMs,
      engineTimingsMs: response.timingsMs,
    };
    const inputHash = sha256(canonicalJson(request));
    await q.query(
      `UPDATE planning.planning_run SET status='COMPLETED', engine_version=$2, contract_version=$3, input=$4::jsonb,
         input_hash=$5, accuracy=$6::jsonb, stats=$7::jsonb, completed_at=now() WHERE run_id=$1`,
      [runId, response.engineVersion, response.contractVersion, JSON.stringify(request), inputHash,
        JSON.stringify(accuracy), JSON.stringify(stats)],
    );
    await this.audit.record(q, {
      actor,
      action: "planning-run.completed",
      entityType: "planning-run",
      entityId: runId,
      after: { proposals: response.orders.length, lines: lineCount, accuracy },
      metadata: { inputHash, engineVersion: response.engineVersion },
    });
    await this.outbox.emit(q, "replen.planning.run.completed.v1", runId, 1, {
      runId,
      asOfDate: request.asOfDate,
      engineVersion: response.engineVersion,
      contractVersion: response.contractVersion ?? "1.0.0",
      proposals: response.orders.length,
      lines: lineCount,
      accuracy,
    });
  }

  private toView(r: Record<string, any>): PlanningRunView {
    return {
      runId: r.run_id,
      asOfDate: r.as_of_date,
      status: r.status,
      requestedBy: r.requested_by,
      engineVersion: r.engine_version,
      contractVersion: r.contract_version,
      accuracy: r.accuracy,
      stats: r.stats,
      error: r.error,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    };
  }

  async get(runId: string): Promise<PlanningRunView> {
    const [r] = await this.db.query(
      "SELECT run_id, as_of_date, status, requested_by, engine_version, contract_version, accuracy, stats, error, started_at, completed_at FROM planning.planning_run WHERE run_id=$1",
      [runId],
    );
    if (!r) throw notFound("planning run", runId);
    return this.toView(r);
  }

  async list(): Promise<PlanningRunView[]> {
    const rows = await this.db.query(
      "SELECT run_id, as_of_date, status, requested_by, engine_version, contract_version, accuracy, stats, error, started_at, completed_at FROM planning.planning_run ORDER BY started_at DESC LIMIT 50",
    );
    return rows.map((r) => this.toView(r));
  }

  async frozenInput(runId: string): Promise<PlanRequest> {
    const [r] = await this.db.query<{ input: PlanRequest | null }>("SELECT input FROM planning.planning_run WHERE run_id=$1", [
      runId,
    ]);
    if (!r?.input) throw notFound("planning run input", runId);
    return r.input;
  }

  async simulate(request: PlanRequest): Promise<PlanResponse> {
    return this.engine.plan(request);
  }
}
