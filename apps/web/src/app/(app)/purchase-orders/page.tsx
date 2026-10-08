"use client";

import type { PurchaseOrder } from "@replen/contracts";
import Link from "next/link";
import useSWR from "swr";
import { Card, Empty, StatusPill } from "@/components/ui";
import { fetcher } from "@/lib/api";
import { dateTime, day, gbp } from "@/lib/format";

export default function PurchaseOrders() {
  const { data } = useSWR<PurchaseOrder[]>("/api/v1/purchase-orders", fetcher, { refreshInterval: 3000 });
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Purchase orders</h1>
        <p className="text-sm text-ink-2">
          Created from approved proposals and submitted to the ERP through the anti-corruption adapter. The ERP in this environment is a mock.
        </p>
      </div>
      <Card>
        {!data?.length ? (
          <Empty>No purchase orders yet. Approve a proposal to create one.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">PO</th>
                <th className="px-2 py-2 font-medium">Supplier</th>
                <th className="px-2 py-2 font-medium">Deliver to</th>
                <th className="px-2 py-2 font-medium">Expected</th>
                <th className="px-2 py-2 text-right font-medium">Lines</th>
                <th className="px-2 py-2 text-right font-medium">Value</th>
                <th className="px-2 py-2 font-medium">ERP</th>
                <th className="px-2 py-2 font-medium">Approved by</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((po) => (
                <tr key={po.poId} className="border-b border-line last:border-0 hover:bg-surface-2" data-testid={`po-row-${po.supplierId}`}>
                  <td className="px-4 py-2">
                    <Link href={`/purchase-orders/${po.poId}`} className="font-medium hover:underline">
                      {po.poNumber}
                    </Link>
                    <div className="text-xs text-muted">{dateTime(po.createdAt)}</div>
                  </td>
                  <td className="px-2 py-2">{po.supplierId}</td>
                  <td className="px-2 py-2">{po.destinationLocationId}</td>
                  <td className="px-2 py-2">{day(po.expectedDeliveryDate)}</td>
                  <td className="px-2 py-2 text-right tnum">{po.lines.length}</td>
                  <td className="px-2 py-2 text-right tnum">{gbp(po.totalValue)}</td>
                  <td className="px-2 py-2 tnum">{po.erpPoNumber ?? (po.lastError ? <span className="text-xs text-critical">{po.lastError}</span> : "–")}</td>
                  <td className="px-2 py-2">{po.approvedBy}</td>
                  <td className="px-4 py-2">
                    <StatusPill status={po.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
