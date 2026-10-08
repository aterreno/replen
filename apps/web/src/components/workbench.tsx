"use client";

import type { AuditEvent, Proposal, ProposalLine, ReasonCode, SimulationResult } from "@replen/contracts";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { api, ApiError, fetcher, newIdempotencyKey } from "@/lib/api";
import { codeLabel, dateTime, day, gbp, int, num1, pct } from "@/lib/format";
import { LineChart } from "./line-chart";
import { canPlan, useUser } from "./shell";
import { Button, Card, cx, ErrorNote, ExceptionChip, Field, inputClass, SeverityBadge } from "./ui";

// ---------- engine explanation shape (contracts/engine/plan-response.v1.schema.json#/$defs/Explanation) ----------

type Inputs = Record<string, string | number | boolean | null>;
interface Step {
  key: string;
  label: string;
  value: number;
  unit: string;
  formula?: string | null;
  inputs: Inputs;
}
interface Explanation {
  steps: Step[];
  constraints: { code: string; before: number; after: number; message: string }[];
  exceptions: { code: string; severity: string; message: string }[];
  narrative: string;
  sources: {
    locationId: string;
    channel: string;
    model: string;
    demandClass: string;
    meanOverPeriod: number;
    varianceOverPeriod: number;
    observedDays: number;
    censoredDays: number;
    promoUplift?: number | null;
    yearlySeasonality: boolean;
    shareOfItemDemand?: number | null;
    analogues: { sku: string; similarity: number; dailyRate: number }[];
  }[];
}
interface Chart {
  history: { date: string; units: number; censored: boolean }[];
  forecast: { date: string; mean: number; p10: number; p90: number }[];
  projection: { date: string; withoutOrder: number; withOrder: number }[];
}

const asExplanation = (l: ProposalLine) => l.explanation as unknown as Explanation;
const asChart = (l: ProposalLine) => l.chart as unknown as Chart;
const step = (e: Explanation, key: string) => e.steps.find((s) => s.key === key);

// ---------- calculation ladder ----------

function Row({ op, label, value, detail, strong }: { op?: string; label: string; value: string; detail?: string; strong?: boolean }) {
  return (
    <div className={cx("grid grid-cols-[1.25rem_1fr_auto] items-baseline gap-x-2 py-1.5", strong && "font-semibold")}>
      <span className="text-center text-ink-2">{op}</span>
      <span>
        {label}
        {detail && <span className="block text-xs font-normal text-muted">{detail}</span>}
      </span>
      <span className="text-right tnum">{value}</span>
    </div>
  );
}

export function CalcLadder({ line }: { line: ProposalLine }) {
  const e = asExplanation(line);
  const pp = step(e, "protection_period");
  const fc = step(e, "forecast_over_period");
  const ss = step(e, "safety_stock");
  const sd = step(e, "demand_variability");
  const ip = step(e, "inventory_position");
  const nr = step(e, "net_requirement");
  const upTo = step(e, "order_up_to");
  const i = ip?.inputs ?? {};
  return (
    <div className="space-y-3 text-sm" data-testid="calc-ladder">
      <p className="text-ink-2">{e.narrative}</p>
      {pp && (
        <div className="rounded-md bg-surface-2 px-3 py-2 text-xs text-ink-2">
          Cover demand for <strong className="text-ink">{pp.value} days</strong>: order {day(String(pp.inputs.orderDate))}, delivered{" "}
          {day(String(pp.inputs.deliveryDate))}; the next order ({day(String(pp.inputs.nextOrderDate))}) arrives{" "}
          {day(String(pp.inputs.nextDeliveryDate))}. Lead time {pp.inputs.leadTimeDays} days, review period {pp.inputs.reviewPeriodDays} days.
        </div>
      )}
      <div className="divide-y divide-line">
        {fc && (
          <Row
            label={`Forecast demand over ${pp?.value ?? "?"} days`}
            value={num1(fc.value)}
            detail={`${fc.inputs.sources} demand sources · ${num1(Number(fc.inputs.avgDailyDemand))}/day · item model ${fc.inputs.itemModel ?? fc.inputs.models}${fc.inputs.itemYearlySeasonality ? ", yearly seasonality" : ""}${fc.inputs.itemPromoUplift && Number(fc.inputs.itemPromoUplift) > 1 ? `, promo uplift x${num1(Number(fc.inputs.itemPromoUplift))}` : ""}`}
          />
        )}
        {ss && (
          <Row
            op="+"
            label="Safety stock"
            value={num1(ss.value)}
            detail={`${pct(Number(ss.inputs.serviceLevel), 0)} cycle service level · ${String(ss.inputs.distribution).replace("_", " ")} distribution${ss.inputs.z ? ` · z ${ss.inputs.z}` : ""}${sd ? ` · std dev ${num1(sd.value)} (lead time std ${sd.inputs.leadTimeStdDays} days)` : ""}`}
          />
        )}
        {upTo && <Row op="=" label="Order-up-to level" value={int(upTo.value)} strong />}
        {ip && (
          <Row
            op="-"
            label="Inventory position"
            value={int(ip.value)}
            detail={`on hand ${i.onHandUsed}${Number(i.onHand) < 0 ? ` (recorded ${i.onHand})` : ""} - reserved ${i.reserved} + in transit ${i.inTransit} + on order ${i.onOrderCounted}${Number(i.onOrderExcluded) ? ` (overdue ${i.onOrderExcluded} excluded)` : ""} · not counted: damaged ${i.damagedExcluded}, returns ${i.returnsPendingExcluded}`}
          />
        )}
        {nr && <Row op="=" label="Net requirement" value={num1(nr.value)} strong />}
        {e.constraints.map((c) => (
          <Row key={c.code + c.after} op="->" label={codeLabel(c.code)} value={`${int(c.before)} to ${int(c.after)}`} detail={c.message} />
        ))}
        <Row op="=" label="Recommended order" value={`${int(line.recommendedQty)} units`} detail={`${line.recommendedQty / line.packSize} packs of ${line.packSize}`} strong />
        {line.overriddenBy && (
          <Row
            label="Planner decision"
            value={`${int(line.finalQty)} units`}
            detail={`${codeLabel(line.overrideReason ?? "")} by ${line.overriddenBy}${line.overrideNote ? `: "${line.overrideNote}"` : ""}`}
            strong
          />
        )}
      </div>
      {e.exceptions.length > 0 && (
        <ul className="space-y-1.5">
          {e.exceptions.map((x) => (
            <li key={x.code + x.message} className="flex gap-2 text-xs">
              <SeverityBadge severity={x.severity} compact />
              <span>
                <span className="font-medium text-ink">{codeLabel(x.code)}.</span> <span className="text-ink-2">{x.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- charts ----------

export function DemandChart({ line, asOf }: { line: ProposalLine; asOf: string }) {
  const c = asChart(line);
  const pp = step(asExplanation(line), "protection_period");
  return (
    <LineChart
      testId="demand-chart"
      title="Daily demand: last 8 weeks and forecast to the delivery after next (all sources combined)"
      series={[
        {
          key: "actual",
          label: "Actual",
          color: "var(--series-1)",
          points: c.history.map((h) => ({ x: h.date, y: h.units, flag: h.censored ? "most sources out of stock" : undefined })),
        },
        { key: "forecast", label: "Forecast (mean)", color: "var(--series-2)", points: c.forecast.map((f) => ({ x: f.date, y: f.mean })) },
      ]}
      band={{ label: "P10 to P90", color: "var(--band-2)", points: c.forecast.map((f) => ({ x: f.date, lo: f.p10, hi: f.p90 })) }}
      annotations={[
        { x: asOf, label: "Today" },
        ...(pp ? [{ x: String(pp.inputs.deliveryDate), label: "Delivery" }] : []),
      ]}
    />
  );
}

export function ProjectionChart({ line }: { line: ProposalLine }) {
  const c = asChart(line);
  const pp = step(asExplanation(line), "protection_period");
  // The stored projection uses the recommended quantity; re-derive "with order" for the planner's final quantity.
  const delivery = pp ? String(pp.inputs.deliveryDate) : null;
  const finalPoints = c.projection.map((p) => ({
    x: p.date,
    y: delivery && p.date >= delivery ? p.withoutOrder + line.finalQty : p.withoutOrder,
  }));
  return (
    <LineChart
      testId="projection-chart"
      title={`Projected available stock at the destination (on hand minus reserved, plus receipts, minus forecast)${line.finalQty !== line.recommendedQty ? ", using the final quantity" : ""}`}
      series={[
        { key: "with", label: `With order of ${int(line.finalQty)}`, color: "var(--series-1)", points: finalPoints, step: true },
        {
          key: "without",
          label: "Without this order",
          color: "var(--series-2)",
          points: c.projection.map((p) => ({ x: p.date, y: p.withoutOrder })),
          step: true,
        },
      ]}
      annotations={delivery ? [{ x: delivery, label: "Delivery" }] : []}
    />
  );
}

export function SourcesTable({ line }: { line: ProposalLine }) {
  const e = asExplanation(line);
  return (
    <div className="space-y-2">
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr className="border-b border-line">
            <th className="py-1.5 font-medium">Source</th>
            <th className="py-1.5 font-medium">Demand class</th>
            <th className="py-1.5 font-medium">Model</th>
            <th className="py-1.5 text-right font-medium">Share</th>
            <th className="py-1.5 text-right font-medium">Forecast</th>
            <th className="py-1.5 text-right font-medium">Std dev</th>
            <th className="py-1.5 text-right font-medium">Days used / stockout</th>
          </tr>
        </thead>
        <tbody className="tnum">
          {e.sources.map((s) => (
            <tr key={s.locationId + s.channel} className="border-b border-line last:border-0">
              <td className="py-1.5">
                {s.locationId} <span className="text-muted">{s.channel}</span>
              </td>
              <td className="py-1.5">{s.demandClass}</td>
              <td className="py-1.5">
                {s.model.replaceAll("_", " ")}
                {s.yearlySeasonality && <span className="text-muted"> · yearly</span>}
                {s.promoUplift && s.promoUplift > 1 && <span className="text-muted"> · promo x{num1(s.promoUplift)}</span>}
              </td>
              <td className="py-1.5 text-right">{s.shareOfItemDemand != null ? pct(s.shareOfItemDemand, 0) : ""}</td>
              <td className="py-1.5 text-right">{num1(s.meanOverPeriod)}</td>
              <td className="py-1.5 text-right">{num1(Math.sqrt(s.varianceOverPeriod))}</td>
              <td className="py-1.5 text-right">
                {s.observedDays} / {s.censoredDays}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {e.sources.some((s) => s.analogues.length) && (
        <p className="text-xs text-ink-2">
          Analogues:{" "}
          {[...new Map(e.sources.flatMap((s) => s.analogues).map((a) => [a.sku, a])).values()]
            .map((a) => `${a.sku} (similarity ${num1(a.similarity * 100)}%)`)
            .join(", ")}
        </p>
      )}
      {line.accuracy && (
        <p className="text-xs text-ink-2">
          28-day backtest for this line: WAPE {pct((line.accuracy as { wape?: number }).wape)}, bias{" "}
          {pct((line.accuracy as { bias?: number }).bias)}, naive WAPE {pct((line.accuracy as { naiveWape?: number }).naiveWape)}.
        </p>
      )}
      <p className="text-[11px] text-muted">
        Store sources replenished from this DC are summed into DC demand (assumption A-45). Sparse store series take their share of item-level
        demand (top-down); out-of-stock days are excluded from fitting.
      </p>
    </div>
  );
}

// ---------- override form ----------

export function OverrideForm({
  proposal,
  line,
  onSaved,
}: {
  proposal: Proposal;
  line: ProposalLine;
  onSaved: (p: Proposal) => void;
}) {
  const user = useUser();
  const { data: reasons } = useSWR<ReasonCode[]>("/api/v1/override-reasons", fetcher);
  const [qty, setQty] = useState(line.finalQty);
  const [reason, setReason] = useState(line.overrideReason ?? "");
  const [note, setNote] = useState(line.overrideNote ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setQty(line.finalQty);
    setReason(line.overrideReason ?? "");
    setNote(line.overrideNote ?? "");
    setErrors([]);
  }, [line.lineId, line.finalQty, line.overrideReason, line.overrideNote]);

  const editable = canPlan(user) && (proposal.status === "PROPOSED" || proposal.status === "AWAITING_APPROVAL");
  const save = async (finalQty = qty, reasonCode = reason, n = note) => {
    setSaving(true);
    setErrors([]);
    try {
      const updated = await api<Proposal>(`/api/v1/order-proposals/${proposal.proposalId}/lines/${line.lineId}`, {
        method: "PATCH",
        body: { finalQty, reasonCode, ...(n ? { note: n } : {}), expectedVersion: proposal.version },
      });
      onSaved(updated);
    } catch (e) {
      setErrors(e instanceof ApiError ? e.messages : [String(e)]);
    } finally {
      setSaving(false);
    }
  };
  const moqConflict = line.exceptionCodes.includes("MOQ_CONFLICT");
  const needsDecision = line.severity === "blocking" && !line.resolved;

  return (
    <div className="space-y-3" data-testid="override-form">
      {needsDecision && editable && (
        <div className="rounded-md border border-critical/40 p-3 text-sm">
          <div className="mb-2 font-medium">Decision required</div>
          {moqConflict ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => save(line.moq, "MOQ_ACCEPTED", "")} disabled={saving} data-testid="decide-accept-moq">
                Order the MOQ ({int(line.moq)})
              </Button>
              <Button size="sm" onClick={() => save(0, "MOQ_DECLINED", "")} disabled={saving} data-testid="decide-decline-moq">
                Skip this cycle (0)
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => save(line.recommendedQty, "ACCEPT_RECOMMENDATION", "")} disabled={saving}>
              Accept recommendation ({int(line.recommendedQty)})
            </Button>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Final quantity" hint={`Pack ${line.packSize}${line.moq ? ` · MOQ ${line.moq}` : ""} · recommended ${line.recommendedQty}`}>
          <div className="flex gap-1">
            <button className={cx(inputClass, "w-9 px-0")} onClick={() => setQty(Math.max(0, qty - line.packSize))} disabled={!editable} aria-label="Remove one pack">
              -
            </button>
            <input
              type="number"
              className={cx(inputClass, "w-full text-right tnum")}
              value={qty}
              min={0}
              step={line.packSize}
              onChange={(e) => setQty(Number(e.target.value))}
              disabled={!editable}
              data-testid="final-qty"
            />
            <button className={cx(inputClass, "w-9 px-0")} onClick={() => setQty(qty + line.packSize)} disabled={!editable} aria-label="Add one pack">
              +
            </button>
          </div>
        </Field>
        <Field label="Reason">
          <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} disabled={!editable} data-testid="reason">
            <option value="">Choose a reason</option>
            {(reasons ?? [])
              .filter((r) => r.appliesTo === "override")
              .map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <Field label="Note (required for Other and large overrides)">
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} disabled={!editable} maxLength={500} />
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={() => save()} disabled={!editable || saving || !reason} data-testid="save-override">
          Save line
        </Button>
        <span className="text-xs text-ink-2 tnum">
          Line value {gbp(qty * line.unitCost)}
          {qty !== line.recommendedQty && ` (${qty > line.recommendedQty ? "+" : ""}${gbp((qty - line.recommendedQty) * line.unitCost)} vs recommended)`}
        </span>
      </div>
      {!editable && <p className="text-xs text-muted">{canPlan(user) ? "This proposal is closed." : "Your role is read-only."}</p>}
      <ErrorNote messages={errors} />
    </div>
  );
}

// ---------- approval panel ----------

export function ApprovalPanel({ proposal, onChanged }: { proposal: Proposal; onChanged: (p: Proposal) => void }) {
  const user = useUser();
  const { data: reasons } = useSWR<ReasonCode[]>("/api/v1/override-reasons", fetcher);
  const [comment, setComment] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const a = proposal.approval;
  const open = proposal.status === "PROPOSED" || proposal.status === "AWAITING_APPROVAL";

  const act = async (action: "approve" | "escalate" | "reject") => {
    setBusy(true);
    setErrors([]);
    try {
      const body =
        action === "reject"
          ? { expectedVersion: proposal.version, reasonCode: rejectReason, ...(comment ? { comment } : {}) }
          : { expectedVersion: proposal.version, ...(comment ? { comment } : {}) };
      const updated = await api<Proposal>(`/api/v1/order-proposals/${proposal.proposalId}/${action}`, {
        method: "POST",
        body,
        headers: { "idempotency-key": newIdempotencyKey() },
      });
      setComment("");
      onChanged(updated);
    } catch (e) {
      setErrors(e instanceof ApiError ? e.messages : [String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const limit = a.limit;
  const ratio = limit ? Math.min(1, a.value / limit) : 0;
  return (
    <Card title="Decision" className="h-full">
      <div className="space-y-3 p-4 text-sm" data-testid="approval-panel">
        {canPlan(user) && limit !== null && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-ink-2 tnum">
              <span>
                {gbp(a.value)} of your {gbp(limit)} limit
              </span>
              <span>{pct(a.value / limit, 0)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-select">
              <div className={cx("h-1.5 rounded-full", a.value > limit ? "bg-critical" : "bg-accent")} style={{ width: `${ratio * 100}%` }} />
            </div>
          </div>
        )}
        {proposal.status === "AWAITING_APPROVAL" && (
          <p className="text-xs text-ink-2">
            Escalated by {proposal.escalatedBy} {dateTime(proposal.escalatedAt)}
            {proposal.decisionComment ? `: "${proposal.decisionComment}"` : ""}
          </p>
        )}
        {open && a.reasons.length > 0 && (
          <ul className="space-y-1 text-xs" data-testid="approval-reasons">
            {a.reasons.map((r) => (
              <li key={r.code} className="flex gap-2">
                <SeverityBadge severity={r.code === "APPROVAL_LIMIT_EXCEEDED" ? "warning" : "blocking"} compact />
                <span className="text-ink-2">{r.message}</span>
              </li>
            ))}
          </ul>
        )}
        {open && canPlan(user) ? (
          <>
            <Field label="Comment (optional)">
              <input className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => act("approve")} disabled={busy || !a.canApprove} data-testid="approve">
                Approve and create PO
              </Button>
              {a.canEscalate && (
                <Button onClick={() => act("escalate")} disabled={busy} data-testid="escalate">
                  Request approval
                </Button>
              )}
            </div>
            <div className="flex gap-2 border-t border-line pt-3">
              <select className={cx(inputClass, "flex-1")} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} aria-label="Reject reason">
                <option value="">Reject reason</option>
                {(reasons ?? [])
                  .filter((r) => r.appliesTo === "reject")
                  .map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
              </select>
              <Button variant="danger" onClick={() => act("reject")} disabled={busy || !rejectReason}>
                Reject
              </Button>
            </div>
          </>
        ) : (
          !open && (
            <p className="text-xs text-ink-2">
              {proposal.status === "SUPERSEDED"
                ? "Superseded by a newer planning run."
                : `${proposal.status.toLowerCase()} by ${proposal.decidedBy} ${dateTime(proposal.decidedAt)}`}
              {proposal.decisionComment && proposal.status !== "AWAITING_APPROVAL" ? `: "${proposal.decisionComment}"` : ""}
            </p>
          )
        )}
        <ErrorNote messages={errors} />
        <p className="text-[11px] text-muted">
          Approval commits spend. No order reaches the ERP without a recorded human approval within that person's limit.
        </p>
      </div>
    </Card>
  );
}

// ---------- what-if ----------

export function WhatIf({ proposal }: { proposal: Proposal }) {
  const [lead, setLead] = useState(0);
  const [uplift, setUplift] = useState(0);
  const [sl, setSl] = useState("");
  const [delay, setDelay] = useState(0);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setErrors([]);
    try {
      setResult(
        await api<SimulationResult>(`/api/v1/order-proposals/${proposal.proposalId}/simulate`, {
          method: "POST",
          body: {
            leadTimeDeltaDays: lead,
            demandMultiplier: 1 + uplift / 100,
            ...(sl ? { serviceLevel: Number(sl) } : {}),
            supplierDelayDays: delay,
          },
        }),
      );
    } catch (e) {
      setErrors(e instanceof ApiError ? e.messages : [String(e)]);
    } finally {
      setBusy(false);
    }
  };
  const changed = result?.lines.filter((l) => l.baseline.qty !== l.scenario.qty) ?? [];
  return (
    <div className="space-y-3 p-4" data-testid="what-if">
      <p className="text-xs text-ink-2">
        Re-runs the engine on this run's frozen inputs with the changes below. Nothing is saved and no proposal changes.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label="Lead time change (days)">
          <input type="number" className={inputClass} value={lead} onChange={(e) => setLead(Number(e.target.value))} />
        </Field>
        <Field label="Demand change (%)">
          <input type="number" className={inputClass} value={uplift} onChange={(e) => setUplift(Number(e.target.value))} data-testid="whatif-uplift" />
        </Field>
        <Field label="Service level">
          <select className={inputClass} value={sl} onChange={(e) => setSl(e.target.value)}>
            <option value="">Policy default</option>
            {["0.90", "0.95", "0.97", "0.99"].map((v) => (
              <option key={v} value={v}>
                {pct(Number(v), 0)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Supplier delay on open POs (days)">
          <input type="number" min={0} className={inputClass} value={delay} onChange={(e) => setDelay(Number(e.target.value))} />
        </Field>
        <div className="flex items-end">
          <Button variant="primary" onClick={run} disabled={busy} data-testid="whatif-run">
            {busy ? "Simulating..." : "Simulate"}
          </Button>
        </div>
      </div>
      <ErrorNote messages={errors} />
      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-6 text-sm tnum" data-testid="whatif-totals">
            <span>
              Units {int(result.totals.baselineUnits)} to <strong>{int(result.totals.scenarioUnits)}</strong>
            </span>
            <span>
              Value {gbp(result.totals.baselineValue)} to <strong>{gbp(result.totals.scenarioValue)}</strong>
            </span>
            <span className="text-ink-2">{changed.length} of {result.lines.length} lines change</span>
          </div>
          <table className="w-full text-xs tnum">
            <thead className="text-left text-muted">
              <tr className="border-b border-line">
                <th className="py-1.5 font-medium">SKU</th>
                <th className="py-1.5 text-right font-medium">Qty</th>
                <th className="py-1.5 text-right font-medium">Forecast over period</th>
                <th className="py-1.5 text-right font-medium">Safety stock</th>
                <th className="py-1.5 text-right font-medium">Days of supply</th>
                <th className="py-1.5 text-right font-medium">Stockout without order</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((l) => (
                <tr key={l.sku} className={cx("border-b border-line last:border-0", l.baseline.qty !== l.scenario.qty && "font-medium")}>
                  <td className="py-1.5">{l.sku}</td>
                  <td className="py-1.5 text-right">
                    {l.baseline.qty} to {l.scenario.qty}
                  </td>
                  <td className="py-1.5 text-right">
                    {num1(l.baseline.forecastOverPeriod)} to {num1(l.scenario.forecastOverPeriod)}
                  </td>
                  <td className="py-1.5 text-right">
                    {num1(l.baseline.safetyStock)} to {num1(l.scenario.safetyStock)}
                  </td>
                  <td className="py-1.5 text-right">
                    {num1(l.baseline.daysOfSupplyAfterOrder)} to {num1(l.scenario.daysOfSupplyAfterOrder)}
                  </td>
                  <td className="py-1.5 text-right">
                    {day(l.baseline.projectedStockoutDate)} to {day(l.scenario.projectedStockoutDate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- audit trail ----------

export function AuditTrail({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { data } = useSWR<AuditEvent[]>(`/api/v1/audit-events?entityType=${entityType}&entityId=${entityId}`, fetcher, {
    refreshInterval: 3000,
  });
  return (
    <ol className="divide-y divide-line text-xs" data-testid="audit-trail">
      {(data ?? []).map((a) => (
        <li key={a.eventId} className="grid grid-cols-[8rem_9rem_1fr] gap-3 px-4 py-2">
          <span className="text-muted">{dateTime(a.occurredAt)}</span>
          <span className="font-medium">{a.actor}</span>
          <span>
            {a.action.replace("order-proposal.", "").replace("purchase-order.", "")}
            {a.before != null && a.after != null && (
              <span className="text-ink-2"> · {summarise(a.before)} to {summarise(a.after)}</span>
            )}
            <span className="block truncate text-[10px] text-muted" title={a.hash}>
              hash {a.hash.slice(0, 16)} · correlation {a.correlationId}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function summarise(v: unknown): string {
  if (!v || typeof v !== "object") return String(v);
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${k} ${typeof x === "number" ? int(x) : String(x)}`)
    .join(", ");
}

export { ExceptionChip };
