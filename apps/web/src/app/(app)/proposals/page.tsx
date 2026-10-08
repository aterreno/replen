"use client";

import type { PlanningRun, ProposalSummary } from "@replen/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { canPlan, useUser } from "@/components/shell";
import { Button, Card, cx, Empty, ErrorNote, SeverityBadge, StatusPill } from "@/components/ui";
import { api, ApiError, fetcher, newIdempotencyKey } from "@/lib/api";
import { dateTime, day, gbp, pct } from "@/lib/format";

const TABS = [
  { key: "open", label: "Open", status: "PROPOSED,AWAITING_APPROVAL" },
  { key: "approved", label: "Approved", status: "APPROVED" },
  { key: "rejected", label: "Rejected", status: "REJECTED" },
  { key: "superseded", label: "Superseded", status: "SUPERSEDED" },
];

export default function WorkQueue() {
  const user = useUser();
  const router = useRouter();
  const [tab, setTab] = useState(TABS[0]);
  const { data: proposals, mutate, isLoading } = useSWR<ProposalSummary[]>(
    `/api/v1/order-proposals?status=${tab.status}`,
    fetcher,
  );
  const { data: runs, mutate: mutateRuns } = useSWR<PlanningRun[]>("/api/v1/planning-runs", fetcher);
  const [running, setRunning] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const { data: demo } = useSWR<{ demoMode: boolean; status: string }>("/api/v1/demo", fetcher);
  const [resetting, setResetting] = useState(false);
  const lastRun = runs?.[0];
  const mayRun = canPlan(user) || user.roles.includes("admin");
  const isAdmin = user.roles.includes("admin");

  const resetDemo = async () => {
    setResetting(true);
    setErrors([]);
    try {
      await api("/api/v1/demo/reset", { method: "POST", body: {} });
      await Promise.all([mutate(), mutateRuns()]);
    } catch (e) {
      setErrors(e instanceof ApiError ? e.messages : [String(e)]);
    } finally {
      setResetting(false);
    }
  };

  const runPlanning = async () => {
    setRunning(true);
    setErrors([]);
    try {
      await api("/api/v1/planning-runs", { method: "POST", body: {}, headers: { "idempotency-key": newIdempotencyKey() } });
      await Promise.all([mutate(), mutateRuns()]);
    } catch (e) {
      setErrors(e instanceof ApiError ? e.messages : [String(e)]);
    } finally {
      setRunning(false);
    }
  };

  const open = tab.key === "open";
  const blocking = (proposals ?? []).reduce((s, p) => s + p.unresolvedBlockingCount, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Work queue</h1>
          <p className="text-sm text-ink-2">
            Order proposals for each supplier and destination, decisions needed first.
            {lastRun && (
              <>
                {" "}
                Last run {dateTime(lastRun.completedAt ?? lastRun.startedAt)} as of {day(lastRun.asOfDate)}
                {lastRun.status === "COMPLETED" && lastRun.accuracy?.wape != null && (
                  <> · backtest WAPE {pct(lastRun.accuracy.wape)} vs naive {pct(lastRun.accuracy.naiveWape)}</>
                )}
                {lastRun.status === "FAILED" && <span className="text-critical"> · failed: {lastRun.error}</span>}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {demo?.demoMode && isAdmin && (
            <Button onClick={resetDemo} disabled={resetting} data-testid="reset-demo">
              {resetting ? "Resetting..." : "Reset demo data"}
            </Button>
          )}
          {mayRun && (
            <Button variant="primary" onClick={runPlanning} disabled={running || resetting} data-testid="run-planning">
              {running ? "Planning..." : "Run planning"}
            </Button>
          )}
        </div>
      </div>
      <ErrorNote messages={errors} />

      <div className="flex items-center gap-1 border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab.key === t.key}
            onClick={() => setTab(t)}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab.key === t.key ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
        {open && proposals && (
          <span className="ml-auto text-xs text-ink-2">
            {proposals.length} open · {blocking} line{blocking === 1 ? "" : "s"} need a decision
          </span>
        )}
      </div>

      <Card>
        {isLoading ? (
          <Empty>Loading...</Empty>
        ) : !proposals?.length ? (
          <Empty>{open ? "Nothing to review. Run planning to generate proposals." : "No proposals."}</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Attention</th>
                <th className="px-2 py-2 font-medium">Supplier</th>
                <th className="px-2 py-2 font-medium">Deliver to</th>
                <th className="px-2 py-2 font-medium">Order / delivery</th>
                <th className="px-2 py-2 text-right font-medium">Lines</th>
                <th className="px-2 py-2 text-right font-medium">Value</th>
                <th className="px-2 py-2 font-medium">Approval</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => {
                const withinLimit = user.approvalLimit === null || p.finalValue <= user.approvalLimit;
                return (
                  <tr
                    key={p.proposalId}
                    onClick={() => router.push(`/proposals/${p.proposalId}`)}
                    className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2"
                    data-testid={`proposal-row-${p.supplierId}`}
                  >
                    <td className="px-4 py-2.5">
                      {p.unresolvedBlockingCount > 0 ? (
                        <span className="flex items-center gap-2">
                          <SeverityBadge severity="blocking" compact />
                          <span className="text-xs">{p.unresolvedBlockingCount} to decide</span>
                        </span>
                      ) : p.warningCount > 0 ? (
                        <span className="flex items-center gap-2">
                          <SeverityBadge severity="warning" compact />
                          <span className="text-xs text-ink-2">
                            {p.warningCount} warning{p.warningCount === 1 ? "" : "s"}
                          </span>
                        </span>
                      ) : (
                        <SeverityBadge severity="none" />
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <Link href={`/proposals/${p.proposalId}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {p.supplierName}
                      </Link>
                      <div className="text-xs text-muted">{p.supplierId}</div>
                    </td>
                    <td className="px-2 py-2.5">{p.destinationLocationId}</td>
                    <td className="px-2 py-2.5 whitespace-nowrap">
                      {day(p.orderDate)} <span className="text-muted">to</span> {day(p.expectedDeliveryDate)}
                    </td>
                    <td className="px-2 py-2.5 text-right tnum">
                      {p.orderedLineCount}
                      <span className="text-muted">/{p.lineCount}</span>
                    </td>
                    <td className="px-2 py-2.5 text-right tnum">
                      {gbp(p.finalValue)}
                      {Math.abs(p.finalValue - p.recommendedValue) > 0.005 && (
                        <div className="text-xs text-muted">rec. {gbp(p.recommendedValue)}</div>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-xs text-ink-2">
                      {p.status === "AWAITING_APPROVAL"
                        ? `Escalated by ${p.escalatedBy}`
                        : open && canPlan(user)
                          ? withinLimit
                            ? "Within your limit"
                            : "Needs escalation"
                          : p.decidedBy
                            ? `by ${p.decidedBy}`
                            : ""}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusPill status={p.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
