"use client";

import type { PlanningRun, Proposal, ProposalLine } from "@replen/contracts";
import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Card, cx, Empty, ExceptionChip, SeverityBadge, StatusPill } from "@/components/ui";
import {
  ApprovalPanel,
  AuditTrail,
  CalcLadder,
  DemandChart,
  OverrideForm,
  ProjectionChart,
  SourcesTable,
  WhatIf,
} from "@/components/workbench";
import { fetcher } from "@/lib/api";
import { codeLabel, day, gbp, int, num1 } from "@/lib/format";

const DETAIL_TABS = ["Why this quantity", "Demand and forecast", "Stock projection", "Forecast inputs"] as const;
const LOWER_TABS = ["What-if", "History"] as const;

export default function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: proposal, mutate, error } = useSWR<Proposal>(`/api/v1/order-proposals/${id}`, fetcher, {
    refreshInterval: (p) => (p?.status === "APPROVED" && (!p.purchaseOrder || p.purchaseOrder.status === "CREATED") ? 1000 : 0),
  });
  const { data: run } = useSWR<PlanningRun>(proposal ? `/api/v1/planning-runs/${proposal.runId}` : null, fetcher);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof DETAIL_TABS)[number]>(DETAIL_TABS[0]);
  const [lower, setLower] = useState<(typeof LOWER_TABS)[number]>("What-if");

  useEffect(() => {
    if (proposal && !selected) setSelected(proposal.lines[0]?.lineId ?? null);
  }, [proposal, selected]);
  const line = useMemo(() => proposal?.lines.find((l) => l.lineId === selected) ?? null, [proposal, selected]);

  if (error) return <Empty>Proposal not found.</Empty>;
  if (!proposal) return <Empty>Loading...</Empty>;
  const update = (p: Proposal) => mutate(p, { revalidate: false });

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="text-xs text-ink-2">
        <Link href="/proposals" className="hover:underline">
          Work queue
        </Link>{" "}
        / {proposal.supplierId}
      </div>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold" data-testid="proposal-title">
            {proposal.supplierName}
          </h1>
          <p className="text-sm text-ink-2">
            Deliver to {proposal.destinationLocationId} · order {day(proposal.orderDate)}, expected {day(proposal.expectedDeliveryDate)} · planned
            as of {day(run?.asOfDate)} · version {proposal.version}
          </p>
        </div>
        <div className="flex items-center gap-2" data-testid="proposal-status">
          <StatusPill status={proposal.status} />
        </div>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
        <Card title="Order">
          <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
            <div>
              <div className="text-xs text-ink-2">Order value</div>
              <div className="text-2xl font-semibold" data-testid="order-value">
                {gbp(proposal.finalValue)}
              </div>
              {Math.abs(proposal.finalValue - proposal.recommendedValue) > 0.005 && (
                <div className="text-xs text-muted">recommended {gbp(proposal.recommendedValue)}</div>
              )}
            </div>
            <div>
              <div className="text-xs text-ink-2">Lines ordered</div>
              <div className="text-2xl font-semibold">
                {proposal.orderedLineCount}
                <span className="text-base font-normal text-muted"> of {proposal.lineCount}</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-2">Needs decision</div>
              <div className="text-2xl font-semibold" data-testid="unresolved-count">
                {proposal.unresolvedBlockingCount}
              </div>
              <div className="text-xs text-muted">{proposal.warningCount} lines with warnings</div>
            </div>
            <div>
              <div className="text-xs text-ink-2">Purchase order</div>
              {proposal.purchaseOrder ? (
                <Link href={`/purchase-orders/${proposal.purchaseOrder.poId}`} className="block hover:underline" data-testid="po-link">
                  <span className="text-lg font-semibold">{proposal.purchaseOrder.poNumber}</span>
                  <span className="ml-2 align-middle">
                    <StatusPill status={proposal.purchaseOrder.status} />
                  </span>
                  {proposal.purchaseOrder.erpPoNumber && <div className="text-xs text-muted">ERP {proposal.purchaseOrder.erpPoNumber}</div>}
                </Link>
              ) : (
                <div className="text-sm text-muted">{proposal.status === "APPROVED" ? "Creating..." : "Created on approval"}</div>
              )}
            </div>
          </div>
          {(proposal.notes.length > 0 || proposal.orderExceptions.length > 0) && (
            <div className="space-y-1 border-t border-line px-4 py-3 text-xs text-ink-2">
              {proposal.notes.map((n) => (
                <div key={n}>Order optimiser: {n}</div>
              ))}
              {proposal.orderExceptions.map((x) => (
                <div key={x.code} className="flex gap-2">
                  <SeverityBadge severity={x.severity} compact /> {x.message}
                </div>
              ))}
            </div>
          )}
        </Card>
        <ApprovalPanel proposal={proposal} onChanged={update} />
      </div>

      <Card title="Lines" actions={<span className="text-xs text-muted">Select a line to see how its quantity was calculated</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium" />
                <th className="px-2 py-2 font-medium">Product</th>
                <th className="px-2 py-2 text-right font-medium">Forecast</th>
                <th className="px-2 py-2 text-right font-medium">Position</th>
                <th className="px-2 py-2 text-right font-medium">Recommended</th>
                <th className="px-2 py-2 text-right font-medium">Final</th>
                <th className="px-2 py-2 text-right font-medium">Value</th>
                <th className="px-2 py-2 text-right font-medium">Days of supply</th>
                <th className="px-4 py-2 font-medium">Exceptions</th>
              </tr>
            </thead>
            <tbody>
              {proposal.lines.map((l: ProposalLine) => (
                <tr
                  key={l.lineId}
                  onClick={() => setSelected(l.lineId)}
                  className={cx("cursor-pointer border-b border-line last:border-0", l.lineId === selected ? "bg-select" : "hover:bg-surface-2")}
                  data-testid={`line-${l.sku}`}
                  aria-selected={l.lineId === selected}
                >
                  <td className="px-4 py-2">
                    <SeverityBadge severity={l.severity === "blocking" && l.resolved ? "info" : l.severity} compact />
                  </td>
                  <td className="px-2 py-2">
                    <div className="font-medium">{l.productName}</div>
                    <div className="text-xs text-muted">
                      {l.sku} · pack {l.packSize}
                      {l.moq ? ` · MOQ ${l.moq}` : ""}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tnum">
                    {num1(l.forecastOverPeriod)}
                    <div className="text-xs text-muted">{l.protectionPeriodDays} days</div>
                  </td>
                  <td className="px-2 py-2 text-right tnum">{int(l.inventoryPosition)}</td>
                  <td className="px-2 py-2 text-right tnum">{int(l.recommendedQty)}</td>
                  <td className="px-2 py-2 text-right tnum" data-testid={`final-${l.sku}`}>
                    <span className={cx(l.finalQty !== l.recommendedQty && "font-semibold")}>{int(l.finalQty)}</span>
                    {l.overriddenBy && <div className="text-[11px] text-muted">{codeLabel(l.overrideReason ?? "")}</div>}
                  </td>
                  <td className="px-2 py-2 text-right tnum">{gbp(l.finalQty * l.unitCost)}</td>
                  <td className="px-2 py-2 text-right tnum">{num1(l.daysOfSupplyAfterOrder)}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {l.exceptionCodes
                        .filter((c) => c !== "INTERMITTENT_DEMAND")
                        .slice(0, 3)
                        .map((c) => (
                          <ExceptionChip key={c} code={c} severity={c === "MOQ_CONFLICT" || c === "CAPACITY_BELOW_MOQ" ? (l.resolved ? undefined : "blocking") : undefined} />
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {line && (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <Card
            title={
              <span>
                {line.productName} <span className="font-normal text-muted">{line.sku}</span>
              </span>
            }
          >
            <div className="flex gap-1 border-b border-line px-3" role="tablist">
              {DETAIL_TABS.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cx("-mb-px border-b-2 px-2.5 py-2 text-xs", tab === t ? "border-ink font-medium" : "border-transparent text-ink-2")}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="p-4">
              {tab === "Why this quantity" && <CalcLadder line={line} />}
              {tab === "Demand and forecast" && run && <DemandChart line={line} asOf={run.asOfDate} />}
              {tab === "Stock projection" && <ProjectionChart line={line} />}
              {tab === "Forecast inputs" && <SourcesTable line={line} />}
            </div>
          </Card>
          <Card title="Adjust line">
            <div className="p-4">
              <OverrideForm proposal={proposal} line={line} onSaved={update} />
            </div>
          </Card>
        </div>
      )}

      <Card>
        <div className="flex gap-1 border-b border-line px-3" role="tablist">
          {LOWER_TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={lower === t}
              onClick={() => setLower(t)}
              className={cx("-mb-px border-b-2 px-2.5 py-2 text-xs", lower === t ? "border-ink font-medium" : "border-transparent text-ink-2")}
            >
              {t}
            </button>
          ))}
        </div>
        {lower === "What-if" ? <WhatIf proposal={proposal} /> : <AuditTrail entityType="order-proposal" entityId={proposal.proposalId} />}
      </Card>
    </div>
  );
}
