"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { int, num1, shortDay } from "@/lib/format";

export interface Series {
  key: string;
  label: string;
  color: string; // CSS var reference, e.g. var(--series-1)
  points: { x: string; y: number | null; flag?: string }[];
  /** Hold each value until the next point (stock levels change at day boundaries). */
  step?: boolean;
}

export interface Band {
  label: string;
  color: string;
  points: { x: string; lo: number; hi: number }[];
}

export interface Annotation {
  x: string;
  label: string;
}

const M = { top: 12, right: 16, bottom: 26, left: 44 };

function niceStep(range: number, target = 4) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/**
 * Single-axis line chart: 2px lines, hairline grid, optional P10-P90 band as a 10% wash, crosshair that snaps to
 * the nearest date with one tooltip listing every series, legend always shown for 2+ series, and a table view.
 */
export function LineChart({
  title,
  series,
  band,
  annotations = [],
  height = 220,
  unit = "units",
  testId,
}: {
  title: string;
  series: Series[];
  band?: Band;
  annotations?: Annotation[];
  height?: number;
  unit?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const xs = useMemo(() => {
    const all = new Set<string>();
    series.forEach((s) => s.points.forEach((p) => all.add(p.x)));
    band?.points.forEach((p) => all.add(p.x));
    return [...all].sort();
  }, [series, band]);

  const { yMin, yMax, ticks } = useMemo(() => {
    const vals: number[] = [0];
    series.forEach((s) => s.points.forEach((p) => p.y !== null && vals.push(p.y)));
    band?.points.forEach((p) => vals.push(p.lo, p.hi));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals, 1);
    const step = niceStep(hi - lo);
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const t: number[] = [];
    for (let v = min; v <= max + step / 2; v += step) t.push(Number(v.toFixed(6)));
    return { yMin: min, yMax: max, ticks: t };
  }, [series, band]);

  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const xIndex = useMemo(() => new Map(xs.map((x, i) => [x, i])), [xs]);
  const sx = (x: string) => M.left + ((xIndex.get(x) ?? 0) / Math.max(1, xs.length - 1)) * innerW;
  const sy = (y: number) => M.top + (1 - (y - yMin) / (yMax - yMin || 1)) * innerH;

  const path = (pts: { x: string; y: number | null }[], step = false) => {
    let d = "";
    let pen = false;
    let prevY = 0;
    for (const p of pts) {
      if (p.y === null) {
        pen = false;
        continue;
      }
      const x = sx(p.x).toFixed(1);
      const y = sy(p.y).toFixed(1);
      if (pen && step) d += `L${x},${prevY.toFixed(1)}`;
      d += `${pen ? "L" : "M"}${x},${y}`;
      prevY = sy(p.y);
      pen = true;
    }
    return d;
  };

  const bandPath = band
    ? `M${band.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.hi).toFixed(1)}`).join("L")}` +
      `L${[...band.points].reverse().map((p) => `${sx(p.x).toFixed(1)},${sy(p.lo).toFixed(1)}`).join("L")}Z`
    : "";

  const tickEvery = Math.max(1, Math.ceil(xs.length / Math.max(2, Math.floor(innerW / 70))));
  const hx = hover !== null ? xs[hover] : null;
  const valueAt = (s: Series, x: string) => s.points.find((p) => p.x === x);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const rel = (e.clientX - box.left) / box.width;
    setHover(Math.round(rel * (xs.length - 1)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(xs.length - 1, (h ?? -1) + 1));
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? xs.length) - 1));
    if (e.key === "Escape") setHover(null);
  };

  const tooltipLeft = hx ? Math.min(Math.max(sx(hx) + 10, 0), width - 190) : 0;

  return (
    <figure className="m-0" data-testid={testId}>
      <figcaption className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span id={titleId} className="text-xs font-medium text-ink-2">
          {title}
        </span>
        <span className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
          {series.length > 1 &&
            series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} aria-hidden />
                {s.label}
              </span>
            ))}
          {band && (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: band.color }} aria-hidden />
              {band.label}
            </span>
          )}
          <button className="text-accent-ink hover:underline" onClick={() => setShowTable((v) => !v)}>
            {showTable ? "Chart" : "Table"}
          </button>
        </span>
      </figcaption>
      {showTable ? (
        <div className="max-h-64 overflow-auto rounded border border-line">
          <table className="w-full text-xs tnum">
            <thead className="sticky top-0 bg-surface text-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="px-2 py-1 text-right font-medium">
                    {s.label}
                  </th>
                ))}
                {band && <th className="px-2 py-1 text-right font-medium">{band.label}</th>}
              </tr>
            </thead>
            <tbody>
              {xs.map((x) => (
                <tr key={x} className="border-t border-line">
                  <td className="px-2 py-1">{shortDay(x)}</td>
                  {series.map((s) => {
                    const p = valueAt(s, x);
                    return (
                      <td key={s.key} className="px-2 py-1 text-right">
                        {p?.y == null ? "" : num1(p.y)}
                        {p?.flag ? ` (${p.flag})` : ""}
                      </td>
                    );
                  })}
                  {band && (
                    <td className="px-2 py-1 text-right">
                      {(() => {
                        const b = band.points.find((p) => p.x === x);
                        return b ? `${num1(b.lo)} to ${num1(b.hi)}` : "";
                      })()}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative">
          <svg
            width={width}
            height={height}
            role="img"
            aria-labelledby={titleId}
            tabIndex={0}
            onKeyDown={onKey}
            className="block select-none"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={M.left}
                  x2={width - M.right}
                  y1={sy(t)}
                  y2={sy(t)}
                  stroke={t === 0 ? "var(--baseline)" : "var(--grid)"}
                  strokeWidth={1}
                />
                <text x={M.left - 6} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted)" className="tnum">
                  {int(t)}
                </text>
              </g>
            ))}
            {xs.map((x, i) =>
              i % tickEvery === 0 ? (
                <text key={x} x={sx(x)} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--muted)">
                  {shortDay(x)}
                </text>
              ) : null,
            )}
            {band && <path d={bandPath} fill={band.color} stroke="none" />}
            {annotations
              .filter((a) => xIndex.has(a.x))
              .map((a) => (
                <g key={a.label}>
                  <line x1={sx(a.x)} x2={sx(a.x)} y1={M.top} y2={M.top + innerH} stroke="var(--baseline)" strokeWidth={1} />
                  <text x={sx(a.x) + 4} y={M.top + 9} fontSize={10} fill="var(--ink-2)">
                    {a.label}
                  </text>
                </g>
              ))}
            {series.map((s) => (
              <path key={s.key} d={path(s.points, s.step)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {series.map((s) =>
              s.points
                .filter((p) => p.flag && p.y !== null)
                .map((p) => (
                  <circle key={`${s.key}-${p.x}`} cx={sx(p.x)} cy={sy(p.y!)} r={4} fill="var(--surface)" stroke={s.color} strokeWidth={2} />
                )),
            )}
            {hx && (
              <g pointerEvents="none">
                <line x1={sx(hx)} x2={sx(hx)} y1={M.top} y2={M.top + innerH} stroke="var(--ink-2)" strokeWidth={1} />
                {series.map((s) => {
                  const p = valueAt(s, hx);
                  return p?.y == null ? null : (
                    <circle key={s.key} cx={sx(hx)} cy={sy(p.y)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  );
                })}
              </g>
            )}
            <rect
              x={M.left}
              y={M.top}
              width={innerW}
              height={innerH}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
          {hx && (
            <div
              className="pointer-events-none absolute top-2 z-10 w-44 rounded-md border border-line bg-surface px-2.5 py-2 text-xs shadow-sm"
              style={{ left: tooltipLeft }}
              role="status"
            >
              <div className="mb-1 text-muted">{shortDay(hx)}</div>
              {series.map((s) => {
                const p = valueAt(s, hx);
                if (p?.y == null) return null;
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
                    <span className="font-semibold text-ink tnum">{num1(p.y)}</span>
                    <span className="text-ink-2">
                      {s.label}
                      {p.flag ? `, ${p.flag}` : ""}
                    </span>
                  </div>
                );
              })}
              {band &&
                (() => {
                  const b = band.points.find((p) => p.x === hx);
                  return b ? (
                    <div className="mt-0.5 text-ink-2 tnum">
                      {band.label}: {num1(b.lo)} to {num1(b.hi)}
                    </div>
                  ) : null;
                })()}
              <div className="mt-1 text-[10px] text-muted">{unit}</div>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
