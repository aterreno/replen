"use client";

import type { KpiValue, Kpis } from "@replen/contracts";
import { useState } from "react";
import useSWR from "swr";
import { Card, Empty, SyntheticBadge } from "@/components/ui";
import { fetcher } from "@/lib/api";
import { compact, dateTime, day, gbp0, int, num1, pct } from "@/lib/format";

function formatValue(k: KpiValue): string {
  if (k.value === null || k.value === undefined) return "–";
  switch (k.unit) {
    case "ratio":
      return pct(k.value);
    case "GBP":
      return Math.abs(k.value) >= 10_000 ? `£${compact(k.value)}` : gbp0(k.value);
    case "days":
      return `${num1(k.value)} days`;
    case "hours":
      return `${num1(k.value)} h`;
    case "per year":
      return `${num1(k.value)}x`;
    default:
      return int(k.value);
  }
}

function formatBreakdown(b: { value: number | null; unit: string }): string {
  if (b.value === null) return "–";
  if (b.unit === "ratio") return pct(b.value);
  if (b.unit === "GBP") return gbp0(b.value);
  return int(b.value);
}

function StatTile({ k }: { k: KpiValue }) {
  const [open, setOpen] = useState(false);
  const breakdown = k.breakdown ?? [];
  return (
    <div className="rounded-lg border border-line bg-surface p-4" data-testid={`kpi-${k.key}`}>
      <div className="text-xs text-ink-2">{k.label}</div>
      <div className="mt-1 text-2xl font-semibold" data-testid={`kpi-value-${k.key}`}>
        {formatValue(k)}
      </div>
      {k.key !== "supplier_otif" && breakdown.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-2 tnum">
          {breakdown.map((b) => (
            <span key={b.label}>
              {b.label} {formatBreakdown(b)}
            </span>
          ))}
        </div>
      )}
      <button onClick={() => setOpen((v) => !v)} className="mt-2 text-[11px] text-accent-ink hover:underline">
        {open ? "Hide definition" : "How it is calculated"}
      </button>
      {open && (
        <p className="mt-1 text-[11px] text-ink-2">
          {k.definition}. Source: {k.source}.
        </p>
      )}
    </div>
  );
}

/** Horizontal bars, one series (slot 1): <=24px thick, 4px rounded data end, value at the tip, hover tooltip. */
function OtifBars({ k }: { k: KpiValue }) {
  const rows = (k.breakdown ?? []).map((b) => ({ ...b, deliveries: Number(b.deliveries ?? 0) }));
  const [hover, setHover] = useState<string | null>(null);
  return (
    <figure className="m-0" data-testid="otif-chart">
      <figcaption className="mb-2 text-xs text-ink-2">On time and in full by supplier (share of deliveries, synthetic history)</figcaption>
      <div className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-[6.5rem_1fr] items-center gap-2 text-xs"
            onPointerEnter={() => setHover(r.label)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(r.label)}
            onBlur={() => setHover(null)}
            tabIndex={0}
          >
            <span className="text-ink-2">{r.label}</span>
            <div className="relative flex h-5 items-center border-l border-[var(--baseline)]">
              <div
                className="h-5 rounded-r-[4px] bg-series-1"
                style={{ width: `calc(${(r.value ?? 0) * 100}% - 2.5rem)`, opacity: hover && hover !== r.label ? 0.55 : 1 }}
              />
              <span className="ml-1.5 text-ink tnum">{pct(r.value, 0)}</span>
              {hover === r.label && (
                <div className="absolute -top-8 left-0 z-10 rounded-md border border-line bg-surface px-2 py-1 shadow-sm">
                  <span className="font-semibold text-ink tnum">{pct(r.value)}</span>{" "}
                  <span className="text-ink-2">
                    {r.label}, {r.deliveries} deliveries
                  </span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </figure>
  );
}

export default function KpiPage() {
  const { data } = useSWR<Kpis>("/api/v1/kpis", fetcher, { refreshInterval: 5000 });
  if (!data) return <Empty>Loading...</Empty>;
  const otif = data.groups.flatMap((g) => g.kpis).find((k) => k.key === "supplier_otif");
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">KPIs</h1>
          <p className="text-sm text-ink-2">
            Latest planning run as of {day(data.asOfDate)} · refreshed {dateTime(data.generatedAt)}. Every figure states its definition and source.
          </p>
        </div>
        {data.synthetic && <SyntheticBadge />}
      </div>
      {data.groups.map((g) => (
        <section key={g.group} className="space-y-2">
          <h2 className="text-sm font-semibold">{g.group}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {g.kpis.map((k) => (
              <StatTile key={k.key} k={k} />
            ))}
            {g.group === "Suppliers" && otif && (
              <Card className="p-4 sm:col-span-2 lg:col-span-3">
                <OtifBars k={otif} />
              </Card>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
