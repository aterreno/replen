"""Baseline demand forecasting per series (SKU x location x channel x day).

Models are deliberately simple and explainable. They are the baseline a global ML model must beat
(doc 06), not the end state.

Conventions
- History arrays end on the day before the planning date (`as_of - 1`).
- `observed` is False for censored days (zero stock at open, A-47) and for days outside the ranging
  window. Censored days are excluded from every estimate.
- Forecast arrays start on the planning date.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np

SBA_ALPHA = 0.1
ADI_CUTOFF = 1.32
CV2_CUTOFF = 0.49
MIN_HISTORY_DAYS = 28
LEVEL_MIN_OBS = 14
DOW_SHRINK_DAYS = 8.0
PROMO_SHRINK_DAYS = 10.0
YEARLY_CV_THRESHOLD = 0.3
YEARLY_MIN_MEAN = 0.25
NEW_PRODUCT_MIN_LEVEL_REL_VAR = 0.25


@dataclass(frozen=True)
class Series:
    start: date
    units: np.ndarray  # float64
    observed: np.ndarray  # bool
    promo: np.ndarray  # bool

    @property
    def end(self) -> date:
        """Last date covered (inclusive)."""
        return self.start + timedelta(days=len(self.units) - 1)

    def truncate(self, last_day: date) -> Series:
        n = (last_day - self.start).days + 1
        n = max(0, min(n, len(self.units)))
        return Series(self.start, self.units[:n], self.observed[:n], self.promo[:n])

    def weekdays(self) -> np.ndarray:
        """ISO weekday index 0=Mon..6=Sun for each position."""
        first = self.start.weekday()
        return (np.arange(len(self.units)) + first) % 7

    def dates_index(self, d: date) -> int:
        return (d - self.start).days


@dataclass
class SeriesForecast:
    model: str
    demand_class: str
    mean: np.ndarray  # daily means starting at as_of
    vmr: float  # variance-to-mean ratio of daily demand (>= 1)
    level_rel_var: float  # Var(level estimate) / level^2
    base_level: float
    observed_days: int
    censored_days: int
    promo_uplift: float | None = None
    yearly: bool = False
    yearly_factors: np.ndarray | None = None
    share: float | None = None
    analogues: list[tuple[str, float, float]] = field(default_factory=list)

    def window_mean(self, start: int, end: int) -> float:
        return float(self.mean[start:end].sum())

    def window_variance(self, start: int, end: int) -> float:
        mu = self.window_mean(start, end)
        return self.vmr * mu + self.level_rel_var * mu * mu

    def daily_variance(self) -> np.ndarray:
        return self.vmr * self.mean + self.level_rel_var * self.mean * self.mean


# ---------------------------------------------------------------------------
# Classification (Syntetos-Boylan-Croston categories)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DemandProfile:
    demand_class: str
    adi: float | None
    cv2: float | None
    observed_days: int
    nonzero_days: int


def classify(series: Series, window_days: int = 365) -> DemandProfile:
    units = series.units[-window_days:]
    obs = series.observed[-window_days:]
    y = units[obs]
    n_obs = int(obs.sum())
    nonzero = y[y > 0]
    if n_obs < MIN_HISTORY_DAYS:
        return DemandProfile("new", None, None, n_obs, int(nonzero.size))
    if nonzero.size == 0:
        return DemandProfile("zero", None, None, n_obs, 0)
    adi = n_obs / nonzero.size
    cv2 = float((nonzero.std() / nonzero.mean()) ** 2) if nonzero.size > 1 else 0.0
    if adi < ADI_CUTOFF:
        cls = "smooth" if cv2 < CV2_CUTOFF else "erratic"
    else:
        cls = "intermittent" if cv2 < CV2_CUTOFF else "lumpy"
    return DemandProfile(cls, float(adi), cv2, n_obs, int(nonzero.size))


# ---------------------------------------------------------------------------
# Seasonal moving average: level x yearly ratio x weekday index x promo uplift
# ---------------------------------------------------------------------------


def weekday_indices(series: Series, window_days: int = 364) -> np.ndarray:
    units = series.units[-window_days:]
    mask = series.observed[-window_days:] & ~series.promo[-window_days:]
    dows = series.weekdays()[-window_days:]
    if mask.sum() == 0 or units[mask].mean() <= 0:
        return np.ones(7)
    overall = units[mask].mean()
    idx = np.ones(7)
    for w in range(7):
        m = mask & (dows == w)
        c = int(m.sum())
        if c == 0:
            continue
        raw = units[m].mean() / overall
        idx[w] = 1.0 + (raw - 1.0) * c / (c + DOW_SHRINK_DAYS)
    return idx / idx.mean()


def promo_uplift(series: Series, dow_idx: np.ndarray, window_days: int = 365) -> tuple[float, int]:
    """Ratio of promo-day demand to nearby non-promo demand, shrunk towards 1.

    Comparing against non-promo days within +/-14 days limits confounding with seasonality.
    Returns (uplift, promo days used).
    """
    n = len(series.units)
    lo = max(0, n - window_days)
    dows = series.weekdays()
    u = series.units / dow_idx[dows]
    promo_obs = np.where(series.observed & series.promo)[0]
    promo_obs = promo_obs[promo_obs >= lo]
    base_mask = series.observed & ~series.promo
    num = 0.0
    den = 0.0
    used = 0
    for i in promo_obs:
        a, b = max(0, i - 14), min(n, i + 15)
        local = base_mask[a:b]
        if local.sum() < 5:
            continue
        num += u[i]
        den += u[a:b][local].mean()
        used += 1
    if used < 5 or den <= 0:
        return 1.0, used
    raw = num / den
    shrunk = 1.0 + (raw - 1.0) * used / (used + PROMO_SHRINK_DAYS)
    return float(np.clip(shrunk, 1.0, 5.0)), used


def _deseasonalised(series: Series, dow_idx: np.ndarray, uplift: float) -> np.ndarray:
    factor = dow_idx[series.weekdays()] * np.where(series.promo, uplift, 1.0)
    return series.units / factor


def _recent_level(u: np.ndarray, observed: np.ndarray) -> tuple[float, int, int]:
    """Mean of deseasonalised demand over the most recent window with at least LEVEL_MIN_OBS observed days."""
    for window in (28, 56, 91, 182, 364, len(u)):
        m = observed[-window:]
        if m.sum() >= LEVEL_MIN_OBS or window >= len(u):
            if m.sum() == 0:
                return 0.0, 0, window
            return float(u[-window:][m].mean()), int(m.sum()), window
    return 0.0, 0, len(u)


def _window_mean(u: np.ndarray, observed: np.ndarray, lo: int, hi: int) -> float | None:
    lo, hi = max(lo, 0), min(hi, len(u))
    if hi <= lo:
        return None
    m = observed[lo:hi]
    if m.sum() < 3:
        return None
    return float(u[lo:hi][m].mean())


def yearly_enabled(u: np.ndarray, observed: np.ndarray, vmr: float = 1.0) -> bool:
    """Yearly seasonality is used only if 4-week block means vary more than daily noise explains."""
    if len(u) < 400:
        return False
    last = u[-364:]
    obs = observed[-364:]
    if obs.sum() < 300:
        return False
    annual_mean = float(last[obs].mean())
    if annual_mean < YEARLY_MIN_MEAN:
        return False
    blocks = []
    for b in range(13):
        m = obs[b * 28 : (b + 1) * 28]
        if m.sum() >= 7:
            blocks.append(last[b * 28 : (b + 1) * 28][m].mean())
    if len(blocks) < 10:
        return False
    blocks_arr = np.array(blocks)
    cv2 = float(blocks_arr.var() / blocks_arr.mean() ** 2)
    noise_cv2 = vmr / (annual_mean * 28)
    return cv2 - noise_cv2 >= YEARLY_CV_THRESHOLD**2


def yearly_factors(u: np.ndarray, observed: np.ndarray, level_window: int, horizon: int) -> np.ndarray:
    """Ratio of last year's demand around each target date to last year's demand in the level window.

    Averages the ratio over one and two years back when both are available. Pseudo-count smoothing
    stops near-zero reference windows from producing extreme ratios.
    """
    n = len(u)
    eps = 0.2 * float(u[-364:][observed[-364:]].mean())
    factors = np.ones(horizon)
    for h in range(horizon):
        ratios = []
        for k in (1, 2):
            shift = 364 * k
            ref = _window_mean(u, observed, n - level_window - shift, n - shift)
            # target date as_of + h  ->  index n + h - shift, centred +/- 7 days
            tgt = _window_mean(u, observed, n + h - shift - 7, n + h - shift + 8)
            if ref is None or tgt is None:
                continue
            ratios.append((tgt + eps) / (ref + eps))
        if ratios:
            factors[h] = float(np.clip(np.mean(ratios), 0.2, 5.0))
    return factors


def has_yearly_signal(series: Series) -> bool:
    dow_idx = weekday_indices(series)
    uplift, _ = promo_uplift(series, dow_idx)
    u = _deseasonalised(series, dow_idx, uplift)
    return yearly_enabled(u, series.observed, residual_vmr(u, series.observed))


def residual_vmr(u: np.ndarray, observed: np.ndarray, window_days: int = 91) -> float:
    """Variance-to-mean ratio of deseasonalised demand around a centred 15-day moving average."""
    n = len(u)
    lo = max(0, n - window_days)
    sq = []
    vals = []
    for i in range(lo, n):
        if not observed[i]:
            continue
        a, b = max(0, i - 7), min(n, i + 8)
        m = observed[a:b]
        if m.sum() < 5:
            continue
        local = u[a:b][m].mean()
        sq.append((u[i] - local) ** 2)
        vals.append(u[i])
    if not vals or np.mean(vals) <= 0:
        return 1.0
    vmr = float(np.mean(sq) * 15.0 / 14.0 / np.mean(vals))
    return max(1.0, vmr)


def fit_seasonal_ma(
    series: Series,
    horizon: int,
    future_promo: np.ndarray,
    profile: DemandProfile,
    yearly_override: np.ndarray | None = None,
    uplift_fallback: float | None = None,
) -> SeriesForecast:
    """Level x yearly ratio x weekday index x promo uplift.

    `yearly_override` passes item-level (pooled) yearly factors to a single location, which has too little
    data to estimate its own. `uplift_fallback` does the same for promo uplift.
    """
    dow_idx = weekday_indices(series)
    uplift, used = promo_uplift(series, dow_idx)
    if used < 5 and uplift_fallback is not None:
        uplift = uplift_fallback
    u = _deseasonalised(series, dow_idx, uplift)
    level, n_level, level_window = _recent_level(u, series.observed)
    vmr = residual_vmr(u, series.observed)
    if yearly_override is not None:
        yearly, yf = True, yearly_override[:horizon]
    elif yearly_enabled(u, series.observed, vmr):
        yearly, yf = True, yearly_factors(u, series.observed, level_window, horizon)
    else:
        yearly, yf = False, np.ones(horizon)
    first_future_dow = (series.end + timedelta(days=1)).weekday()
    dows = (np.arange(horizon) + first_future_dow) % 7
    mean = level * yf * dow_idx[dows] * np.where(future_promo, uplift, 1.0)
    level_rel_var = vmr / (level * n_level) if level > 0 and n_level > 0 else 0.0
    return SeriesForecast(
        model="seasonal_ma",
        demand_class=profile.demand_class,
        mean=mean,
        vmr=vmr,
        level_rel_var=level_rel_var,
        base_level=level,
        observed_days=int(series.observed.sum()),
        censored_days=int((~series.observed).sum()),
        promo_uplift=uplift,
        yearly=yearly,
        yearly_factors=yf if yearly else None,
    )


# ---------------------------------------------------------------------------
# Intermittent demand: Syntetos-Boylan approximation of Croston's method
# ---------------------------------------------------------------------------


def sba_rate(y: np.ndarray, alpha: float = SBA_ALPHA) -> tuple[float, float, float]:
    """Return (daily rate, smoothed size z, smoothed interval p) over an observed-only sequence."""
    nonzero = y[y > 0]
    if nonzero.size == 0:
        return 0.0, 0.0, float("inf")
    z = float(nonzero.mean())
    p = float(len(y) / nonzero.size)
    q = 1
    for v in y:
        if v > 0:
            z += alpha * (v - z)
            p += alpha * (q - p)
            q = 1
        else:
            q += 1
    rate = (1 - alpha / 2) * z / p
    return rate, z, p


def fit_sba(series: Series, horizon: int, profile: DemandProfile, window_days: int = 365) -> SeriesForecast:
    obs = series.observed[-window_days:]
    y = series.units[-window_days:][obs]
    rate, _z, p = sba_rate(y)
    mean_y = float(y.mean()) if y.size else 0.0
    vmr = max(1.0, float(y.var() / mean_y)) if mean_y > 0 else 1.0
    n_eff = (2 / SBA_ALPHA - 1) * p
    level_rel_var = vmr / (rate * n_eff) if rate > 0 else 0.0
    return SeriesForecast(
        model="sba",
        demand_class=profile.demand_class,
        mean=np.full(horizon, rate),
        vmr=vmr,
        level_rel_var=level_rel_var,
        base_level=rate,
        observed_days=int(series.observed.sum()),
        censored_days=int((~series.observed).sum()),
    )


def fit_zero(series: Series, horizon: int, profile: DemandProfile) -> SeriesForecast:
    return SeriesForecast(
        model="zero",
        demand_class=profile.demand_class,
        mean=np.zeros(horizon),
        vmr=1.0,
        level_rel_var=0.0,
        base_level=0.0,
        observed_days=int(series.observed.sum()),
        censored_days=int((~series.observed).sum()),
    )


def fit_short_history(series: Series, horizon: int, profile: DemandProfile) -> SeriesForecast:
    y = series.units[series.observed]
    level = float(y.mean()) if y.size else 0.0
    vmr = max(1.0, float(y.var() / level)) if level > 0 else 1.0
    level_rel_var = max(vmr / (level * y.size), NEW_PRODUCT_MIN_LEVEL_REL_VAR) if level > 0 else 0.0
    return SeriesForecast(
        model="short_history_mean",
        demand_class=profile.demand_class,
        mean=np.full(horizon, level),
        vmr=vmr,
        level_rel_var=level_rel_var,
        base_level=level,
        observed_days=int(y.size),
        censored_days=int((~series.observed).sum()),
    )


def forecast_series(
    series: Series,
    horizon: int,
    future_promo: np.ndarray | None = None,
) -> SeriesForecast:
    """Classify the series and fit the matching baseline model.

    New series (fewer than 28 observed days) fall back to their own short history here; the planner
    replaces that with an analogue forecast when analogues are available.
    """
    if future_promo is None:
        future_promo = np.zeros(horizon, dtype=bool)
    profile = classify(series)
    if profile.demand_class in ("smooth", "erratic"):
        return fit_seasonal_ma(series, horizon, future_promo, profile)
    if profile.demand_class in ("intermittent", "lumpy"):
        if has_yearly_signal(series):
            # Sparse at daily grain but strongly seasonal (garden, Christmas): SBA would average the season away.
            return fit_seasonal_ma(series, horizon, future_promo, profile)
        return fit_sba(series, horizon, profile)
    if profile.demand_class == "zero":
        return fit_zero(series, horizon, profile)
    if profile.observed_days >= 7:
        return fit_short_history(series, horizon, profile)
    return fit_zero(series, horizon, profile)


def apply_lifecycle(
    fc: SeriesForecast, as_of: date, launch_date: date | None, end_of_life: date | None
) -> SeriesForecast:
    horizon = len(fc.mean)
    days = np.array([as_of + timedelta(days=h) for h in range(horizon)])
    mask = np.ones(horizon, dtype=bool)
    if launch_date is not None:
        mask &= days >= launch_date
    if end_of_life is not None:
        mask &= days < end_of_life
    fc.mean = np.where(mask, fc.mean, 0.0)
    return fc


# ---------------------------------------------------------------------------
# Item-level pooling and top-down disaggregation
# ---------------------------------------------------------------------------


def demand_shares(series_list: list[Series], window_days: int = 365) -> np.ndarray:
    """Each source's share of item demand, from mean demand on its own observed days."""
    rates = []
    for s in series_list:
        obs = s.observed[-window_days:]
        y = s.units[-window_days:][obs]
        rates.append(float(y.mean()) if y.size else 0.0)
    r = np.array(rates)
    total = r.sum()
    return r / total if total > 0 else np.full(len(r), 1.0 / max(len(r), 1))


def pool_series(series_list: list[Series], shares: np.ndarray, min_share_observed: float = 0.5) -> Series:
    """Sum of sources with censored sources imputed by their demand share.

    pooled(t) = sum of observed units / share observed. A day counts as observed when sources covering at
    least `min_share_observed` of demand were in stock.
    """
    n = len(series_list[0].units)
    units = np.zeros(n)
    share_obs = np.zeros(n)
    promo = np.zeros(n, dtype=bool)
    for s, sh in zip(series_list, shares, strict=True):
        units += np.where(s.observed, s.units, 0.0)
        share_obs += np.where(s.observed, sh, 0.0)
        promo |= s.promo
    observed = share_obs >= min_share_observed
    pooled = np.where(observed, units / np.maximum(share_obs, 1e-9), 0.0)
    return Series(series_list[0].start, pooled, observed, promo)


def top_down(pooled: SeriesForecast, share: float, own: Series, profile: DemandProfile) -> SeriesForecast:
    """Sparse location forecast = location's share of item demand x item-level forecast."""
    obs = own.observed[-365:]
    y = own.units[-365:][obs]
    mean_y = float(y.mean()) if y.size else 0.0
    vmr = max(1.0, float(y.var() / mean_y)) if mean_y > 0 else 1.0
    events = int((y > 0).sum())
    return SeriesForecast(
        model="top_down",
        demand_class=profile.demand_class,
        mean=pooled.mean * share,
        vmr=vmr,
        level_rel_var=pooled.level_rel_var + 1.0 / max(events, 1),
        base_level=pooled.base_level * share,
        observed_days=int(own.observed.sum()),
        censored_days=int((~own.observed).sum()),
        promo_uplift=pooled.promo_uplift,
        yearly=pooled.yearly,
        share=share,
    )


def forecast_sources(
    series_list: list[Series], horizon: int, promos: list[np.ndarray]
) -> tuple[list[SeriesForecast], SeriesForecast]:
    """Forecast every source of one item. Returns (per-source forecasts, pooled item forecast).

    Pooled item demand carries the seasonality and promo signal. Smooth sources get their own level and
    weekday profile with pooled yearly factors; sparse sources get a top-down share of the pooled forecast.
    """
    shares = demand_shares(series_list)
    pooled = pool_series(series_list, shares)
    pooled_promo = np.zeros(horizon, dtype=bool)
    for p in promos:
        pooled_promo |= p
    pooled_fc = forecast_series(pooled, horizon, pooled_promo)
    out = []
    for s, share, promo in zip(series_list, shares, promos, strict=True):
        profile = classify(s)
        if pooled_fc.model == "zero" or profile.demand_class == "zero":
            out.append(fit_zero(s, horizon, profile))
        elif profile.demand_class == "new":
            out.append(forecast_series(s, horizon, promo))
        elif profile.demand_class in ("smooth", "erratic"):
            out.append(fit_seasonal_ma(s, horizon, promo, profile, pooled_fc.yearly_factors, pooled_fc.promo_uplift))
        else:
            out.append(top_down(pooled_fc, float(share), s, profile))
    return out, pooled_fc


# ---------------------------------------------------------------------------
# Accuracy metrics
# ---------------------------------------------------------------------------


def wape(forecast: np.ndarray, actual: np.ndarray) -> float | None:
    total = float(np.sum(actual))
    if total <= 0:
        return None
    return float(np.sum(np.abs(forecast - actual)) / total)


def bias(forecast: np.ndarray, actual: np.ndarray) -> float | None:
    total = float(np.sum(actual))
    if total <= 0:
        return None
    return float(np.sum(forecast - actual) / total)


def seasonal_naive(series: Series, horizon: int) -> np.ndarray:
    """Repeat the last observed week. Censored days in that week use the 28-day observed mean."""
    last_week = series.units[-7:].copy()
    obs = series.observed[-7:]
    recent = series.units[-28:][series.observed[-28:]]
    fill = float(recent.mean()) if recent.size else 0.0
    last_week[~obs] = fill
    reps = int(np.ceil(horizon / 7))
    return np.tile(last_week, reps)[:horizon]
