from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest

from replen_engine.contracts import DemandSource, InventoryBuckets, Lifecycle, OpenOrder, PlanItem, Policy, Sourcing
from replen_engine.forecast import Series, SeriesForecast
from replen_engine.store import AnalyticsStore
from replen_engine.synthetic import AS_OF, generate

MONDAY = date(2026, 10, 5)


def make_series(units, observed=None, promo=None, end: date = MONDAY - timedelta(days=1)) -> Series:
    units = np.asarray(units, dtype=float)
    n = len(units)
    observed = np.ones(n, dtype=bool) if observed is None else np.asarray(observed, dtype=bool)
    promo = np.zeros(n, dtype=bool) if promo is None else np.asarray(promo, dtype=bool)
    return Series(end - timedelta(days=n - 1), units, observed, promo)


def flat_forecast(rate: float, horizon: int = 80, vmr: float = 1.0, level_rel_var: float = 0.0) -> SeriesForecast:
    return SeriesForecast(
        model="seasonal_ma",
        demand_class="smooth",
        mean=np.full(horizon, rate),
        vmr=vmr,
        level_rel_var=level_rel_var,
        base_level=rate,
        observed_days=365,
        censored_days=0,
    )


def make_item(**overrides) -> PlanItem:
    base = dict(
        sku="SKU-1",
        destination_location_id="DC1",
        unit_price=20.0,
        demand_sources=[DemandSource(location_id="DC1", channel="online")],
        sourcing=Sourcing(
            supplier_id="SUP-1",
            lead_time_days=7,
            lead_time_std_days=1.0,
            order_weekdays=[1, 2, 3, 4, 5, 6, 7],
            delivery_weekdays=None,
            moq=0,
            pack_size=12,
            unit_cost=8.0,
        ),
        lifecycle=Lifecycle(),
        policy=Policy(service_level=0.95),
        inventory=InventoryBuckets(on_hand=30, reserved=5, in_transit=10, damaged=3, returns_pending=2),
        open_orders=[OpenOrder(reference="PO-1", quantity=20, expected_date=MONDAY + timedelta(days=3))],
    )
    base.update(overrides)
    return PlanItem(**base)


@pytest.fixture(scope="session")
def synthetic_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("synthetic")
    generate(d)
    return d


@pytest.fixture(scope="session")
def store(synthetic_dir, tmp_path_factory):
    db = tmp_path_factory.mktemp("duck") / "analytics.duckdb"
    s = AnalyticsStore(db)
    s.import_dir(synthetic_dir)
    return s


@pytest.fixture(scope="session")
def as_of() -> date:
    return AS_OF
