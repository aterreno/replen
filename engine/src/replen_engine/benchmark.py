"""Throughput benchmark for forecasting + policy on in-memory series (no I/O)."""

from __future__ import annotations

import platform
import time
from datetime import date, timedelta

import numpy as np

from .contracts import DemandSource, InventoryBuckets, PlanItem, Policy, Sourcing
from .forecast import Series, forecast_series
from .policy import SourceInput, build_line

AS_OF = date(2026, 10, 5)


def _random_series(rng: np.random.Generator, days: int) -> Series:
    kind = rng.integers(0, 3)
    t = np.arange(days)
    if kind == 0:  # smooth with weekly + yearly seasonality
        lam = rng.uniform(0.5, 20) * (1 + 0.3 * np.sin(2 * np.pi * t / 7)) * (1 + 0.5 * np.sin(2 * np.pi * t / 365))
        units = rng.poisson(lam * rng.gamma(5, 0.2, days)).astype(float)
    elif kind == 1:  # intermittent
        units = np.where(rng.random(days) < rng.uniform(0.02, 0.3), 1 + rng.poisson(0.5, days), 0).astype(float)
    else:  # erratic
        units = rng.poisson(rng.uniform(0.2, 5) * rng.gamma(0.8, 1.25, days)).astype(float)
    observed = rng.random(days) > 0.01
    promo = np.zeros(days, dtype=bool)
    return Series(AS_OF - timedelta(days=days), units, observed, promo)


def run_benchmark(n_series: int, days: int, seed: int = 7) -> dict:
    rng = np.random.default_rng(seed)
    series = [_random_series(rng, days) for _ in range(n_series)]
    horizon = 70
    t = time.perf_counter()
    forecasts = [forecast_series(s, horizon) for s in series]
    t_forecast = time.perf_counter() - t

    item = PlanItem(
        sku="BENCH",
        destination_location_id="DC1",
        unit_price=10,
        demand_sources=[DemandSource(location_id="DC1", channel="online")],
        sourcing=Sourcing(
            supplier_id="S",
            lead_time_days=14,
            lead_time_std_days=2,
            order_weekdays=[1, 4],
            moq=12,
            pack_size=6,
            unit_cost=4,
        ),
        policy=Policy(service_level=0.95),
        inventory=InventoryBuckets(on_hand=20, reserved=2),
    )
    t = time.perf_counter()
    for s, fc in zip(series, forecasts, strict=True):
        build_line(item, AS_OF, [SourceInput(item.demand_sources[0], s, fc)], None)
    t_policy = time.perf_counter() - t
    models: dict[str, int] = {}
    for fc in forecasts:
        models[fc.model] = models.get(fc.model, 0) + 1
    return {
        "series": n_series,
        "historyDays": days,
        "forecastSeconds": round(t_forecast, 3),
        "policySeconds": round(t_policy, 3),
        "seriesPerSecondForecast": round(n_series / t_forecast, 1),
        "linesPerSecondPolicy": round(n_series / t_policy, 1),
        "models": models,
        "machine": f"{platform.system()} {platform.machine()} Python {platform.python_version()}",
        "note": "single process, single core, in-memory series, no I/O",
    }
