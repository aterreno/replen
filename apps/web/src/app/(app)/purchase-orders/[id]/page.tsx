"use client";

import type { PurchaseOrder } from "@replen/contracts";
import Link from "next/link";
import { use, useState } from "react";
import useSWR from "swr";
import { canPlan, useUser } from "@/components/shell";
import { Button, Card, Empty, ErrorNote, StatusPill } from "@/components/ui";
import { AuditTrail } from "@/components/workbench";
import { api, ApiError, fetcher } from "@/lib/api";
import { day, gbp, int } from "@/lib/format";

export default function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useUser();
  const { data: po, mutate } = useSWR<PurchaseOrder>(`/api/v1/purchase-orders/${id}`, fetcher, { refreshInterval: 2000 });
  const [errors, setErrors] = useState<string[]>([]);
  if (!po) return <Empty>Loading...</Empty>;
  const retry = async () => {
    setErrors([]);
    try {
      await mutate(await api<PurchaseOrder>(`/api/v1/purchase-orders/${id}/retry-submission`, { method: "POST", body: {} }), { revalidate: false });
    } catch (e) {
      setErrors(e instanceof ApiError ? e.messages : [String(e)]);
    }
  };
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="text-xs text-ink-2">
        <Link href="/purchase-orders" className="hover:underline">
          Purchase orders
        </Link>{" "}
        / {po.poNumber}
      </div>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{po.poNumber}</h1>
          <p className="text-sm text-ink-2">
            {po.supplierId} to {po.destinationLocationId} · order {day(po.orderDate)}, expected {day(po.expectedDeliveryDate)} · approved by{" "}
            {po.approvedBy} ·{" "}
            <Link href={`/proposals/${po.sourceProposalId}`} className="text-accent-ink hover:underline">
              source proposal
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={po.status} />
          {po.status === "SUBMISSION_FAILED" && (canPlan(user) || user.roles.includes("admin")) && (
            <Button size="sm" onClick={retry}>
              Retry submission
            </Button>
          )}
        </div>
      </header>
      <ErrorNote messages={errors} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="ERP">
          <dl className="space-y-1 p-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-2">ERP number</dt>
              <dd className="font-medium tnum">{po.erpPoNumber ?? "–"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-2">Attempts</dt>
              <dd className="tnum">{po.submissionAttempts}</dd>
            </div>
            {po.lastError && <dd className="text-xs text-critical">{po.lastError}</dd>}
          </dl>
        </Card>
        <Card title="Value" className="md:col-span-2">
          <div className="p-4 text-2xl font-semibold tnum">{gbp(po.totalValue)}</div>
        </Card>
      </div>
      <Card title="Lines">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">SKU</th>
              <th className="px-2 py-2 text-right font-medium">Quantity</th>
              <th className="px-2 py-2 text-right font-medium">Unit cost</th>
              <th className="px-4 py-2 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="tnum">
            {po.lines.map((l) => (
              <tr key={l.lineNo} className="border-b border-line last:border-0">
                <td className="px-4 py-2">{l.lineNo}</td>
                <td className="px-2 py-2">{l.sku}</td>
                <td className="px-2 py-2 text-right">{int(l.quantity)}</td>
                <td className="px-2 py-2 text-right">{gbp(l.unitCost)}</td>
                <td className="px-4 py-2 text-right">{gbp(l.quantity * l.unitCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="History">
        <AuditTrail entityType="purchase-order" entityId={po.poId} />
      </Card>
    </div>
  );
}
