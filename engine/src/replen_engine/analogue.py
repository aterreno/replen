"""New-product forecasting from attribute-similar analogues.

Similarity is a hand-weighted attribute distance, chosen so a planner can read why an analogue was
picked. Weights are assumptions to be tuned by backtesting launches (doc 06).
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from .forecast import NEW_PRODUCT_MIN_LEVEL_REL_VAR, Series, SeriesForecast, forecast_series

WEIGHTS = {"subcategory": 1.0, "brand": 0.5, "colour_family": 0.25, "log_price": 1.0}
TOP_K = 3
MIN_ANALOGUE_OBSERVED_DAYS = 90


@dataclass(frozen=True)
class ProductAttributes:
    sku: str
    category: str
    subcategory: str
    brand: str
    colour_family: str
    unit_price: float


def similarity(a: ProductAttributes, b: ProductAttributes) -> float:
    if a.category != b.category:
        return 0.0
    d = 0.0
    d += WEIGHTS["subcategory"] * (a.subcategory != b.subcategory)
    d += WEIGHTS["brand"] * (a.brand != b.brand)
    d += WEIGHTS["colour_family"] * (a.colour_family != b.colour_family)
    if a.unit_price > 0 and b.unit_price > 0:
        d += WEIGHTS["log_price"] * abs(math.log(a.unit_price / b.unit_price))
    return math.exp(-d)


def analogue_forecast(
    target: ProductAttributes,
    candidates: list[ProductAttributes],
    load_series: Callable[[str], Series | None],
    horizon: int,
    future_promo: np.ndarray,
) -> SeriesForecast | None:
    scored = sorted(
        ((similarity(target, c), c) for c in candidates if c.sku != target.sku),
        key=lambda t: (-t[0], t[1].sku),
    )
    chosen: list[tuple[float, str, SeriesForecast]] = []
    for sim, cand in scored:
        if sim <= 0 or len(chosen) >= TOP_K:
            break
        series = load_series(cand.sku)
        if series is None or int(series.observed[-365:].sum()) < MIN_ANALOGUE_OBSERVED_DAYS:
            continue
        fc = forecast_series(series, horizon, future_promo)
        if fc.model in ("zero", "short_history_mean"):
            continue
        chosen.append((sim, cand.sku, fc))
    if not chosen:
        return None
    w = np.array([s for s, _, _ in chosen])
    w = w / w.sum()
    mean = sum(wi * fc.mean for wi, (_, _, fc) in zip(w, chosen, strict=True))
    rates = np.array([float(fc.mean.mean()) for _, _, fc in chosen])
    avg_rate = float(np.dot(w, rates))
    disagreement = float(np.dot(w, (rates - avg_rate) ** 2) / avg_rate**2) if avg_rate > 0 else 0.0
    vmr = max(1.0, float(np.dot(w, [fc.vmr for _, _, fc in chosen])))
    return SeriesForecast(
        model="analogue",
        demand_class="new",
        mean=np.asarray(mean, dtype=float),
        vmr=vmr,
        level_rel_var=max(NEW_PRODUCT_MIN_LEVEL_REL_VAR, disagreement),
        base_level=avg_rate,
        observed_days=0,
        censored_days=0,
        analogues=[(sku, round(float(sim), 4), round(float(fc.mean.mean()), 4)) for sim, sku, fc in chosen],
    )
