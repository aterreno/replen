"use client";

import type { AuditEvent, OutboxEvent } from "@replen/contracts";
import { useState } from "react";
import useSWR from "swr";
import { Card, cx } from "@/components/ui";
import { fetcher } from "@/lib/api";
import { dateTime } from "@/lib/format";

export default function Activity() {
  const { data: events } = useSWR<OutboxEvent[]>("/api/v1/events?limit=200", fetcher, { refreshInterval: 3000 });
  const { data: audit } = useSWR<AuditEvent[]>("/api/v1/audit-events?limit=200", fetcher, { refreshInterval: 3000 });
  const { data: verify } = useSWR<{ valid: boolean; checked: number; firstInvalidSeq: number | null }>(
    "/api/v1/audit-events/verify",
    fetcher,
    { refreshInterval: 5000 },
  );
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Events and audit</h1>
        <p className="text-sm text-ink-2">
          Domain events from the transactional outbox (CloudEvents, published locally to a log file in place of Pub/Sub) and the hash-chained audit
          log.
        </p>
      </div>
      <div
        className={cx("rounded-md border px-3 py-2 text-sm", verify?.valid ? "border-good/50" : "border-critical/50")}
        data-testid="audit-verify"
      >
        {verify
          ? verify.valid
            ? `Audit chain verified: ${verify.checked} entries, no gaps or edits.`
            : `Audit chain broken at entry ${verify.firstInvalidSeq}.`
          : "Verifying audit chain..."}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Domain events (${events?.length ?? 0})`}>
          <ol className="max-h-[70vh] divide-y divide-line overflow-auto text-xs">
            {(events ?? []).map((e) => {
              const ev = e.event;
              return (
                <li key={e.seq} className="px-4 py-2">
                  <button className="w-full text-left" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{ev.type.replace(/^replen\./, "")}</span>
                      <span className="text-muted">{dateTime(ev.time)}</span>
                    </div>
                    <div className="text-muted">
                      subject {ev.subject.slice(0, 8)} · v{ev.aggregateversion} · {e.publishedAt ? "published" : e.deadLetteredAt ? "dead-lettered" : "pending"}
                      {e.attempts > 1 ? ` · ${e.attempts} attempts` : ""}
                    </div>
                  </button>
                  {open === e.seq && (
                    <pre className="mt-2 max-h-72 overflow-auto rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(e.event, null, 2)}</pre>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>
        <Card title={`Audit log (${audit?.length ?? 0})`}>
          <ol className="max-h-[70vh] divide-y divide-line overflow-auto text-xs">
            {(audit ?? []).map((a) => (
              <li key={a.eventId} className="px-4 py-2">
                <div className="flex justify-between gap-2">
                  <span>
                    <span className="font-medium">{a.actor}</span> {a.action}
                  </span>
                  <span className="text-muted">{dateTime(a.occurredAt)}</span>
                </div>
                <div className="truncate text-muted" title={a.hash}>
                  {a.entityType} {a.entityId.slice(0, 8)} · #{a.seq} · hash {a.hash.slice(0, 12)}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
