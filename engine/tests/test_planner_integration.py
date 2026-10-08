"""Plan the full synthetic dataset and check every planted edge case, plus a golden snapshot of quantities."""

import json
import os
from pathlib import Path

import pytest

from replen_engine.contracts import Scenario
from replen_engine.dataset import build_plan_request
from replen_engine.planner import plan

GOLDEN = Path(__file__).parent / "fixtures" / "golden_recommendations.json"


@pytest.fixture(scope="module")
def response(store, synthetic_dir, as_of):
    req = build_plan_request(synthetic_dir, as_of, persist=False)
    with store.connect() as con:
        return plan(req, con)


def item(resp, sku):
    return next(i for i in resp.items if i.sku == sku)


def exc_codes(i):
    return {e.code for e in i.explanation.exceptions}


def con_codes(i):
    return {c.code for c in i.explanation.constraints}


def test_every_item_planned(response):
    assert len(response.items) == 33
    assert response.contract_version == "1.0.0"


def test_quantities_are_pack_multiples(response, synthetic_dir):
    import csv

    packs = {r["sku"]: int(r["pack_size"]) for r in csv.DictReader((synthetic_dir / "sourcing.csv").open())}
    for i in response.items:
        assert i.recommended_qty % packs[i.sku] == 0, i.sku
        assert i.recommended_qty >= 0


@pytest.mark.parametrize(
    "sku,expected",
    [
        ("HOM-VAS-001", "MOQ_CONFLICT"),
        ("FUR-LMP-001", "ZERO_DEMAND"),
        ("FAS-SHT-001", "DISCONTINUED"),
        ("FAS-JMP-002", "EOL_BEFORE_ARRIVAL"),
        ("HOM-BED-002", "NEGATIVE_STOCK"),
        ("FUR-BKC-001", "OVERDUE_PO_COUNTED"),
        ("FUR-TBL-001", "OVERDUE_PO_EXCLUDED"),
        ("HOM-CUS-002", "NEW_PRODUCT_ANALOGUE"),
        ("ELE-HEA-002", "PRE_LAUNCH"),
        ("FUR-SOF-001", "CAPACITY_CAPPED"),
        ("ELE-HEA-001", "RESERVED_EXCEEDS_ON_HAND"),
        ("ELE-TOA-001", "PROMO_WITHOUT_HISTORY"),
    ],
)
def test_planted_edge_cases(response, sku, expected):
    assert expected in exc_codes(item(response, sku))


def test_moq_applied_and_mov_topup_and_budget(response):
    assert "MOQ_APPLIED" in con_codes(item(response, "HOM-CAN-001"))
    assert any("MOV_TOPUP" in con_codes(i) for i in response.items if i.supplier_id == "SUP-ELEC")
    fash = next(o for o in response.orders if o.supplier_id == "SUP-FASH")
    assert fash.total_value <= 4500
    assert "BUDGET_CONSTRAINED" in {e.code for e in fash.exceptions}
    elec = next(o for o in response.orders if o.supplier_id == "SUP-ELEC")
    assert elec.total_value >= 6000


def test_suppressed_lines_are_zero(response):
    for sku in ("FAS-SHT-001", "FAS-JMP-002", "FUR-LMP-001", "ELE-HEA-002"):
        assert item(response, sku).recommended_qty == 0, sku


def test_new_product_lists_analogues(response):
    i = item(response, "HOM-CUS-002")
    analogues = {a.sku for s in i.explanation.sources for a in s.analogues}
    assert "HOM-CUS-001" in analogues


def test_forecast_beats_seasonal_naive_on_backtest(response):
    acc = response.accuracy
    assert acc.series_evaluated >= 25
    assert acc.wape < acc.naive_wape
    assert abs(acc.bias) < 0.1


def test_christmas_items_ramp_up(response):
    lights = item(response, "SEA-XLT-001")
    first, last = lights.forecast[0].mean, lights.forecast[-1].mean
    assert last > first * 1.5


def test_deterministic(store, synthetic_dir, as_of, response):
    req = build_plan_request(synthetic_dir, as_of, persist=False)
    with store.connect() as con:
        again = plan(req, con)
    a = response.model_dump(exclude={"timings_ms"})
    b = again.model_dump(exclude={"timings_ms"})
    assert a == b


def test_golden_recommendations(response):
    actual = {i.sku: i.recommended_qty for i in response.items}
    if os.environ.get("UPDATE_GOLDEN") == "1" or not GOLDEN.exists():
        GOLDEN.write_text(json.dumps(actual, indent=2, sort_keys=True) + "\n")
    assert actual == json.loads(GOLDEN.read_text())


def test_scenario_demand_uplift_increases_orders(store, synthetic_dir, as_of, response):
    req = build_plan_request(synthetic_dir, as_of, persist=False, scenario=Scenario(demand_multiplier=1.5))
    with store.connect() as con:
        uplift = plan(req, con)
    base_total = sum(i.forecast_over_period for i in response.items)
    up_total = sum(i.forecast_over_period for i in uplift.items)
    assert up_total == pytest.approx(base_total * 1.5, rel=1e-6)


def test_persist_writes_forecasts(store, synthetic_dir, as_of):
    req = build_plan_request(synthetic_dir, as_of, run_id="persist-test", persist=True)
    with store.connect() as con:
        plan(req, con)
        n = con.execute("SELECT count(*) FROM forecast_daily WHERE run_id = 'persist-test'").fetchone()[0]
        m = con.execute("SELECT count(*) FROM forecast_accuracy WHERE run_id = 'persist-test'").fetchone()[0]
    assert n > 0
    assert m >= 25
