const gbpFmt = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbpWhole = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const intFmt = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const dec1 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const gbp = (x: number | null | undefined) => (x === null || x === undefined ? "–" : gbpFmt.format(x));
export const gbp0 = (x: number | null | undefined) => (x === null || x === undefined ? "–" : gbpWhole.format(x));
export const int = (x: number | null | undefined) => (x === null || x === undefined ? "–" : intFmt.format(x));
export const num1 = (x: number | null | undefined) => (x === null || x === undefined ? "–" : dec1.format(x));
export const pct = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined ? "–" : `${(x * 100).toFixed(digits)}%`;

export function day(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function shortDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function compact(x: number | null | undefined): string {
  if (x === null || x === undefined) return "–";
  return new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(x);
}

const LABELS: Record<string, string> = {
  MOQ_CONFLICT: "MOQ conflict",
  MOQ_APPLIED: "MOQ applied",
  NEGATIVE_STOCK: "Negative stock",
  RESERVED_EXCEEDS_ON_HAND: "Reserved > on hand",
  OVERDUE_PO_COUNTED: "Overdue PO counted",
  OVERDUE_PO_EXCLUDED: "Overdue PO excluded",
  DISCONTINUED: "Discontinued",
  EOL_BEFORE_ARRIVAL: "End of life",
  ZERO_DEMAND: "Zero demand",
  NEW_PRODUCT_ANALOGUE: "New product",
  NO_HISTORY_NO_ANALOGUE: "No history",
  PRE_LAUNCH: "Pre-launch",
  PROMO_WITHOUT_HISTORY: "Promo, no history",
  INTERMITTENT_DEMAND: "Intermittent",
  HIGH_UNCERTAINTY: "High uncertainty",
  CAPACITY_CAPPED: "Capacity capped",
  CAPACITY_BELOW_MOQ: "Capacity < MOQ",
  PROJECTED_STOCKOUT_BEFORE_ARRIVAL: "Stockout before delivery",
  BUDGET_REDUCED: "Budget cut",
  BUDGET_CONSTRAINED: "Budget constrained",
  ORDER_DEFERRED_BELOW_MOV: "Below supplier minimum",
  MOV_TOPUP: "Topped up to MOV",
  PACK_ROUNDING: "Case pack rounding",
  ACCEPT_RECOMMENDATION: "Accepted as recommended",
  FORECAST_TOO_LOW: "Forecast too low",
  FORECAST_TOO_HIGH: "Forecast too high",
  PROMO_NOT_IN_FORECAST: "Promo not in forecast",
  MOQ_ACCEPTED: "MOQ accepted",
  MOQ_DECLINED: "MOQ declined",
  SUPPLIER_ISSUE: "Supplier issue",
  CAPACITY: "Capacity",
  BUDGET: "Budget",
  DATA_QUALITY: "Data quality",
  OTHER: "Other",
  ORDER_DEFERRED: "Order deferred",
};

export const codeLabel = (code: string) => LABELS[code] ?? code.toLowerCase().replaceAll("_", " ");
