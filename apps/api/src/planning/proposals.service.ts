import { Inject, Injectable } from "@nestjs/common";
import type { PlanRequest } from "@replen/contracts";
import { AuditService } from "../audit/audit.service.js";
import { conflict, DomainError, notFound, unprocessable } from "../common/errors.js";
import { round2 } from "../common/util.js";
import { DB, type Db, type Queryable } from "../db/db.js";
import type { AppUser } from "../identity/identity.js";
import { OutboxService } from "../messaging/outbox.service.js";
import { PurchasingService } from "../purchasing/purchasing.service.js";
import { ReferenceService } from "../reference/reference.service.js";
import { PlanningService } from "./planning.service.js";
import { evaluateApproval, OVERRIDE_REASONS, REASON_STATUS, REJECT_REASONS, validateAdjustment } from "./rules.js";

interface ProposalRow {
  proposal_id: string;
  run_id: string;
  supplier_id: string;
  destination_location_id: string;
  order_date: string;
  expected_delivery_date: string;
  status: string;
  version: number;
  currency: string;
  recommended_value: number;
  solver_status: string | null;
  notes: string[];
  order_exceptions: object[];
  escalated_by: string | null;
  escalated_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  created_at: string;
}

interface LineRow {
  line_id: string;
  proposal_id: string;
  sku: string;
  unit_cost: number;
  pack_size: number;
  moq: number;
  recommended_qty: number;
  final_qty: number;
  override_reason: string | null;
  override_note: string | null;
  overridden_by: string | null;
  overridden_at: string | null;
  forecast_over_period: number;
  order_up_to: number;
  safety_stock: number;
  inventory_position: number;
  protection_period_days: number;
  days_of_supply_after_order: number | null;
  projected_stockout_date: string | null;
  severity: "none" | "info" | "warning" | "blocking";
  exception_codes: string[];
  explanation: Record<string, unknown>;
  chart: Record<string, unknown>;
  accuracy: Record<string, unknown> | null;
}

const SEVERITY_RANK = { blocking: 0, warning: 1, info: 2, none: 3 };

function totals(lines: LineRow[]) {
  const finalValue = round2(lines.reduce((s, l) => s + l.final_qty * l.unit_cost, 0));
  const unresolvedBlocking = lines.filter((l) => l.severity === "blocking" && !l.overridden_by).length;
  return {
    finalValue,
    unresolvedBlocking,
    blocking: lines.filter((l) => l.severity === "blocking").length,
    warning: lines.filter((l) => l.severity === "warning").length,
    ordered: lines.filter((l) => l.final_qty > 0).length,
  };
}

@Injectable()
export class ProposalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly reference: ReferenceService,
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
    private readonly planning: PlanningService,
  ) {}

  reasons() {
    return [
      ...Object.entries(OVERRIDE_REASONS).map(([code, label]) => ({ code, label, appliesTo: "override" })),
      ...Object.entries(REJECT_REASONS).map(([code, label]) => ({ code, label, appliesTo: "reject" })),
    ];
  }

  private async lines(q: Queryable, proposalIds: string[]): Promise<LineRow[]> {
    if (proposalIds.length === 0) return [];
    return q.query<LineRow>("SELECT * FROM planning.proposal_line WHERE proposal_id = ANY($1::uuid[])", [proposalIds]);
  }

  private summary(p: ProposalRow, lines: LineRow[], supplierNames: Map<string, string>) {
    const t = totals(lines);
    return {
      proposalId: p.proposal_id,
      runId: p.run_id,
      supplierId: p.supplier_id,
      supplierName: supplierNames.get(p.supplier_id) ?? p.supplier_id,
      destinationLocationId: p.destination_location_id,
      orderDate: p.order_date,
      expectedDeliveryDate: p.expected_delivery_date,
      status: p.status,
      version: p.version,
      lineCount: lines.length,
      orderedLineCount: t.ordered,
      recommendedValue: p.recommended_value,
      finalValue: t.finalValue,
      currency: p.currency.trim(),
      blockingCount: t.blocking,
      unresolvedBlockingCount: t.unresolvedBlocking,
      warningCount: t.warning,
      createdAt: p.created_at,
      escalatedBy: p.escalated_by,
      decidedBy: p.decided_by,
      decidedAt: p.decided_at,
    };
  }

  async list(filter: { status?: string; supplierId?: string }) {
    const status = filter.status ? filter.status.split(",") : ["PROPOSED", "AWAITING_APPROVAL", "APPROVED", "REJECTED"];
    const rows = await this.db.query<ProposalRow>(
      `SELECT * FROM planning.order_proposal WHERE status = ANY($1) AND ($2::text IS NULL OR supplier_id = $2)
       ORDER BY created_at DESC LIMIT 200`,
      [status, filter.supplierId ?? null],
    );
    const lines = await this.lines(this.db, rows.map((r) => r.proposal_id));
    const names = new Map((await this.reference.suppliers()).map((s) => [s.supplierId, s.name]));
    const summaries = rows.map((r) => this.summary(r, lines.filter((l) => l.proposal_id === r.proposal_id), names));
    const openFirst = (s: string) => (s === "PROPOSED" || s === "AWAITING_APPROVAL" ? 0 : 1);
    return summaries.sort(
      (a, b) =>
        openFirst(a.status) - openFirst(b.status) ||
        b.unresolvedBlockingCount - a.unresolvedBlockingCount ||
        b.warningCount - a.warningCount ||
        b.finalValue - a.finalValue,
    );
  }

  private async load(q: Queryable, proposalId: string, lock = false): Promise<{ p: ProposalRow; lines: LineRow[] }> {
    const [p] = await q.query<ProposalRow>(
      `SELECT * FROM planning.order_proposal WHERE proposal_id = $1${lock ? " FOR UPDATE" : ""}`,
      [proposalId],
    );
    if (!p) throw notFound("order proposal", proposalId);
    return { p, lines: await this.lines(q, [proposalId]) };
  }

  async get(proposalId: string, user: AppUser) {
    const { p, lines } = await this.load(this.db, proposalId);
    const [suppliers, products, pos] = await Promise.all([
      this.reference.suppliers(),
      this.reference.products(lines.map((l) => l.sku)),
      this.purchasing.forProposals([proposalId]),
    ]);
    const names = new Map(suppliers.map((s) => [s.supplierId, s.name]));
    const productBySku = new Map(products.map((x) => [x.sku, x]));
    const t = totals(lines);
    const po = pos.get(proposalId);
    const sorted = [...lines].sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.final_qty * b.unit_cost - a.final_qty * a.unit_cost ||
        a.sku.localeCompare(b.sku),
    );
    return {
      ...this.summary(p, lines, names),
      solverStatus: p.solver_status,
      notes: p.notes,
      orderExceptions: p.order_exceptions,
      escalatedAt: p.escalated_at,
      decisionComment: p.decision_comment,
      purchaseOrder: po ? { poId: po.poId, poNumber: po.poNumber, status: po.status, erpPoNumber: po.erpPoNumber } : null,
      approval: evaluateApproval(user, {
        status: p.status,
        value: t.finalValue,
        escalatedBy: p.escalated_by,
        unresolvedBlocking: t.unresolvedBlocking,
        orderedLines: t.ordered,
      }),
      lines: sorted.map((l) => ({
        lineId: l.line_id,
        sku: l.sku,
        productName: productBySku.get(l.sku)?.name ?? l.sku,
        category: productBySku.get(l.sku)?.category ?? "",
        unitCost: l.unit_cost,
        packSize: l.pack_size,
        moq: l.moq,
        recommendedQty: l.recommended_qty,
        finalQty: l.final_qty,
        overrideReason: l.override_reason,
        overrideNote: l.override_note,
        overriddenBy: l.overridden_by,
        overriddenAt: l.overridden_at,
        forecastOverPeriod: l.forecast_over_period,
        orderUpTo: l.order_up_to,
        safetyStock: l.safety_stock,
        inventoryPosition: l.inventory_position,
        protectionPeriodDays: l.protection_period_days,
        daysOfSupplyAfterOrder: l.days_of_supply_after_order,
        projectedStockoutDate: l.projected_stockout_date,
        severity: l.severity,
        exceptionCodes: l.exception_codes,
        resolved: l.severity !== "blocking" || l.overridden_by !== null,
        explanation: l.explanation,
        chart: l.chart,
        accuracy: l.accuracy,
      })),
    };
  }

  private assertOpen(p: ProposalRow, expectedVersion: number) {
    if (p.status !== "PROPOSED" && p.status !== "AWAITING_APPROVAL") {
      throw conflict("NOT_OPEN", `Proposal is ${p.status}`);
    }
    if (p.version !== expectedVersion) {
      throw conflict("VERSION_CONFLICT", `Proposal changed (version ${p.version}, you sent ${expectedVersion}); reload`);
    }
  }

  async adjustLine(
    proposalId: string,
    lineId: string,
    user: AppUser,
    body: { finalQty: number; reasonCode: string; note?: string; expectedVersion: number },
  ) {
    if (!user.roles.some((r) => ["planner", "senior_planner", "head_of_replenishment"].includes(r))) {
      throw new DomainError("ROLE_REQUIRED", 403, "Your role cannot change order quantities");
    }
    await this.db.tx(async (q) => {
      const { p, lines } = await this.load(q, proposalId, true);
      this.assertOpen(p, body.expectedVersion);
      const line = lines.find((l) => l.line_id === lineId);
      if (!line) throw notFound("proposal line", lineId);
      validateAdjustment(
        { packSize: line.pack_size, moq: line.moq, recommendedQty: line.recommended_qty },
        body.finalQty,
        body.reasonCode,
        body.note,
      );
      await q.query(
        `UPDATE planning.proposal_line SET final_qty=$2, override_reason=$3, override_note=$4, overridden_by=$5, overridden_at=now()
         WHERE line_id=$1`,
        [lineId, body.finalQty, body.reasonCode, body.note ?? null, user.userId],
      );
      const version = p.version + 1;
      // Any change after escalation sends the proposal back for a fresh decision.
      await q.query(
        `UPDATE planning.order_proposal SET version=$2, status='PROPOSED', escalated_by=NULL, escalated_at=NULL, updated_at=now()
         WHERE proposal_id=$1`,
        [proposalId, version],
      );
      await this.audit.record(q, {
        actor: user.userId,
        action: "order-proposal.line-adjusted",
        entityType: "order-proposal",
        entityId: proposalId,
        before: { sku: line.sku, finalQty: line.final_qty, overrideReason: line.override_reason },
        after: { sku: line.sku, finalQty: body.finalQty, overrideReason: body.reasonCode },
        metadata: { lineId, recommendedQty: line.recommended_qty, note: body.note ?? null, version },
      });
      await this.outbox.emit(q, "replen.planning.order-proposal.line-adjusted.v1", proposalId, version, {
        proposalId,
        lineId,
        sku: line.sku,
        recommendedQty: line.recommended_qty,
        previousQty: line.final_qty,
        finalQty: body.finalQty,
        reasonCode: body.reasonCode,
        note: body.note ?? null,
        adjustedBy: user.userId,
      });
    });
    return this.get(proposalId, user);
  }

  private check(user: AppUser, p: ProposalRow, lines: LineRow[]) {
    const t = totals(lines);
    return {
      t,
      check: evaluateApproval(user, {
        status: p.status,
        value: t.finalValue,
        escalatedBy: p.escalated_by,
        unresolvedBlocking: t.unresolvedBlocking,
        orderedLines: t.ordered,
      }),
    };
  }

  async approve(proposalId: string, user: AppUser, body: { expectedVersion: number; comment?: string }) {
    await this.db.tx(async (q) => {
      const { p, lines } = await this.load(q, proposalId, true);
      this.assertOpen(p, body.expectedVersion);
      const { t, check } = this.check(user, p, lines);
      if (!check.canApprove) {
        const first = check.reasons[0];
        throw new DomainError(first.code, REASON_STATUS[first.code] ?? 409, first.message, check.reasons as never);
      }
      const version = p.version + 1;
      const approvedAt = new Date().toISOString();
      await q.query(
        `UPDATE planning.order_proposal SET status='APPROVED', version=$2, decided_by=$3, decided_at=$4, decision_comment=$5, updated_at=now()
         WHERE proposal_id=$1`,
        [proposalId, version, user.userId, approvedAt, body.comment ?? null],
      );
      await this.audit.record(q, {
        actor: user.userId,
        action: "order-proposal.approved",
        entityType: "order-proposal",
        entityId: proposalId,
        before: { status: p.status },
        after: { status: "APPROVED", value: t.finalValue },
        metadata: { approvalLimit: user.approvalLimit, escalatedBy: p.escalated_by, comment: body.comment ?? null, version },
      });
      await this.outbox.emit(q, "replen.planning.order-proposal.approved.v1", proposalId, version, {
        proposalId,
        supplierId: p.supplier_id,
        destinationLocationId: p.destination_location_id,
        orderDate: p.order_date,
        expectedDeliveryDate: p.expected_delivery_date,
        currency: p.currency.trim(),
        approvedBy: user.userId,
        approvedAt,
        totalValue: t.finalValue,
        lines: lines
          .filter((l) => l.final_qty > 0)
          .sort((a, b) => a.sku.localeCompare(b.sku))
          .map((l) => ({ lineId: l.line_id, sku: l.sku, quantity: l.final_qty, unitCost: l.unit_cost })),
      });
    });
    return this.get(proposalId, user);
  }

  async escalate(proposalId: string, user: AppUser, body: { expectedVersion: number; comment?: string }) {
    await this.db.tx(async (q) => {
      const { p, lines } = await this.load(q, proposalId, true);
      this.assertOpen(p, body.expectedVersion);
      const { t, check } = this.check(user, p, lines);
      if (!check.canEscalate) {
        throw conflict("CANNOT_ESCALATE", "Escalation is only for open proposals above your limit with no blocking lines");
      }
      const version = p.version + 1;
      await q.query(
        `UPDATE planning.order_proposal SET status='AWAITING_APPROVAL', version=$2, escalated_by=$3, escalated_at=now(),
           decision_comment=$4, updated_at=now() WHERE proposal_id=$1`,
        [proposalId, version, user.userId, body.comment ?? null],
      );
      await this.audit.record(q, {
        actor: user.userId,
        action: "order-proposal.escalated",
        entityType: "order-proposal",
        entityId: proposalId,
        before: { status: p.status },
        after: { status: "AWAITING_APPROVAL", value: t.finalValue },
        metadata: { approvalLimit: user.approvalLimit, version },
      });
      await this.outbox.emit(q, "replen.planning.order-proposal.escalated.v1", proposalId, version, {
        proposalId,
        escalatedBy: user.userId,
        value: t.finalValue,
        escalatorLimit: user.approvalLimit,
      });
    });
    return this.get(proposalId, user);
  }

  async reject(proposalId: string, user: AppUser, body: { expectedVersion: number; reasonCode: string; comment?: string }) {
    if (!(body.reasonCode in REJECT_REASONS)) throw unprocessable("INVALID_REASON", `unknown reason ${body.reasonCode}`);
    if (body.reasonCode === "OTHER" && !body.comment?.trim()) throw unprocessable("COMMENT_REQUIRED", "comment required for OTHER");
    if (!user.roles.some((r) => ["planner", "senior_planner", "head_of_replenishment"].includes(r))) {
      throw new DomainError("ROLE_REQUIRED", 403, "Your role cannot reject proposals");
    }
    await this.db.tx(async (q) => {
      const { p } = await this.load(q, proposalId, true);
      this.assertOpen(p, body.expectedVersion);
      const version = p.version + 1;
      await q.query(
        `UPDATE planning.order_proposal SET status='REJECTED', version=$2, decided_by=$3, decided_at=now(), decision_reason=$4,
           decision_comment=$5, updated_at=now() WHERE proposal_id=$1`,
        [proposalId, version, user.userId, body.reasonCode, body.comment ?? null],
      );
      await this.audit.record(q, {
        actor: user.userId,
        action: "order-proposal.rejected",
        entityType: "order-proposal",
        entityId: proposalId,
        before: { status: p.status },
        after: { status: "REJECTED" },
        metadata: { reasonCode: body.reasonCode, comment: body.comment ?? null, version },
      });
      await this.outbox.emit(q, "replen.planning.order-proposal.rejected.v1", proposalId, version, {
        proposalId,
        rejectedBy: user.userId,
        reasonCode: body.reasonCode,
        comment: body.comment ?? null,
      });
    });
    return this.get(proposalId, user);
  }

  /** What-if on the run's frozen inputs for this proposal's lines. Nothing is persisted. */
  async simulate(
    proposalId: string,
    scenario: { leadTimeDeltaDays?: number; demandMultiplier?: number; serviceLevel?: number; supplierDelayDays?: number },
  ) {
    const { p, lines } = await this.load(this.db, proposalId);
    const input = await this.planning.frozenInput(p.run_id);
    const skus = new Set(lines.map((l) => l.sku));
    const items = input.items.filter((i) => skus.has(i.sku) && i.destinationLocationId === p.destination_location_id);
    const request: PlanRequest = {
      ...input,
      runId: `${p.run_id}-sim`,
      persist: false,
      backtestDays: 0,
      items,
      orderConstraints: input.orderConstraints?.filter(
        (c) => c.supplierId === p.supplier_id && c.destinationLocationId === p.destination_location_id,
      ),
      scenario: {
        leadTimeDeltaDays: scenario.leadTimeDeltaDays ?? 0,
        demandMultiplier: scenario.demandMultiplier ?? 1,
        serviceLevel: scenario.serviceLevel ?? null,
        supplierDelayDays: scenario.supplierDelayDays ?? 0,
      },
    };
    const res = await this.planning.simulate(request);
    const bySku = new Map(res.items.map((i) => [i.sku, i]));
    const cost = new Map(lines.map((l) => [l.sku, l.unit_cost]));
    const out = lines
      .map((l) => {
        const s = bySku.get(l.sku);
        return {
          sku: l.sku,
          baseline: {
            qty: l.recommended_qty,
            forecastOverPeriod: l.forecast_over_period,
            orderUpTo: l.order_up_to,
            safetyStock: l.safety_stock,
            protectionPeriodDays: l.protection_period_days,
            daysOfSupplyAfterOrder: l.days_of_supply_after_order,
            projectedStockoutDate: l.projected_stockout_date,
          },
          scenario: {
            qty: s?.recommendedQty ?? 0,
            forecastOverPeriod: s?.forecastOverPeriod ?? 0,
            orderUpTo: s?.orderUpTo ?? 0,
            safetyStock: s?.safetyStock ?? 0,
            protectionPeriodDays: s?.protectionPeriodDays ?? 0,
            daysOfSupplyAfterOrder: s?.daysOfSupplyAfterOrder ?? null,
            projectedStockoutDate: s?.projectedStockoutDate ?? null,
          },
        };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
    return {
      scenario,
      lines: out,
      totals: {
        baselineUnits: out.reduce((s, l) => s + l.baseline.qty, 0),
        scenarioUnits: out.reduce((s, l) => s + l.scenario.qty, 0),
        baselineValue: round2(out.reduce((s, l) => s + l.baseline.qty * (cost.get(l.sku) ?? 0), 0)),
        scenarioValue: round2(out.reduce((s, l) => s + l.scenario.qty * (cost.get(l.sku) ?? 0), 0)),
      },
    };
  }
}
