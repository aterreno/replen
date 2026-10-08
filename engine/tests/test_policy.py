import math
from datetime import timedelta

import pytest

from replen_engine.contracts import InventoryBuckets, Lifecycle, OpenOrder, Policy, Scenario, Sourcing
from replen_engine.policy import SourceInput, build_line, round_to_pack, to_item_result

from .conftest import MONDAY, flat_forecast, make_item


def line(item, rate=10.0, scenario=None, vmr=1.0, demand_class="smooth"):
    fc = flat_forecast(rate, vmr=vmr)
    fc.demand_class = demand_class
    if rate == 0:
        fc.model = "zero"
    return build_line(item, MONDAY, [SourceInput(item.demand_sources[0], None, fc)], scenario, fc)


def codes(ctx):
    return {e.code for e in ctx.exceptions}


def constraint_codes(ctx):
    return [c.code for c in ctx.constraints]


class TestHandCalculatedExample:
    """Daily ordering, lead time 7 days: protection period 8 days.

    mu = 8 x 10 = 80
    var = vmr*mu + avg_daily^2 * lead_std^2 = 80 + 100 * 1 = 180, sigma = 13.4164
    S = ceil(80 + 1.644854 * 13.4164) = ceil(102.068) = 103
    IP = 30 - 5 + 10 + 20 = 55 (damaged 3 and returns 2 excluded)
    NR = 48 -> 4 packs of 12 = 48
    """

    def test_quantities(self):
        ctx = line(make_item())
        assert ctx.protection_days == 8
        assert ctx.mu == pytest.approx(80.0)
        assert ctx.variance == pytest.approx(180.0)
        assert ctx.order_up_to == 103
        assert ctx.safety_stock == pytest.approx(23.0)
        assert ctx.ip == 55
        assert ctx.net_requirement == 48
        assert ctx.qty == 48

    def test_trace_steps_in_order(self):
        ctx = line(make_item())
        keys = [s.key for s in ctx.steps]
        assert keys == [
            "protection_period",
            "forecast_over_period",
            "demand_variability",
            "safety_stock",
            "order_up_to",
            "inventory_position",
            "net_requirement",
            "pack_rounding",
            "moq",
            "recommended",
        ]
        ip = next(s for s in ctx.steps if s.key == "inventory_position")
        assert ip.inputs["damagedExcluded"] == 3
        assert ip.inputs["returnsPendingExcluded"] == 2

    def test_item_result_and_narrative(self):
        ctx = line(make_item())
        res = to_item_result(ctx, [], None)
        assert res.recommended_qty == 48
        assert res.days_of_supply_after_order == pytest.approx((55 + 48) / 10)
        assert "Order 48 units (4 x 12)" in res.explanation.narrative
        assert res.projection[0].date == MONDAY
        assert len(res.forecast) == len(res.projection)


class TestPackRounding:
    @pytest.mark.parametrize(
        "nr,expected",
        [(0, 0), (48, 48), (50, 48), (51, 60), (2, 0), (3, 12), (12.0000001, 12)],
    )
    def test_threshold(self, nr, expected):
        assert round_to_pack(nr, 12, 0.25) == expected

    def test_pack_of_one(self):
        assert round_to_pack(7.2, 1, 0.25) == 7


class TestInventoryPositionEdgeCases:
    def test_negative_on_hand_clamped_with_exception(self):
        item = make_item(inventory=InventoryBuckets(on_hand=-6, reserved=0), open_orders=[])
        ctx = line(item)
        assert ctx.ip == 0
        assert "NEGATIVE_STOCK" in codes(ctx)

    def test_reserved_exceeding_on_hand_gives_negative_position(self):
        item = make_item(inventory=InventoryBuckets(on_hand=4, reserved=9), open_orders=[])
        ctx = line(item)
        assert ctx.ip == -5
        assert "RESERVED_EXCEEDS_ON_HAND" in codes(ctx)

    def test_overdue_within_grace_counted(self):
        item = make_item(open_orders=[OpenOrder(reference="L", quantity=20, expected_date=MONDAY - timedelta(days=3))])
        ctx = line(item)
        assert ctx.ip == 55
        assert "OVERDUE_PO_COUNTED" in codes(ctx)

    def test_overdue_beyond_grace_excluded(self):
        item = make_item(
            open_orders=[OpenOrder(reference="L", quantity=20, expected_date=MONDAY - timedelta(days=12))]
        )
        ctx = line(item)
        assert ctx.ip == 35
        assert "OVERDUE_PO_EXCLUDED" in codes(ctx)

    def test_supplier_delay_scenario_moves_order_out_of_overdue(self):
        item = make_item(
            open_orders=[OpenOrder(reference="L", quantity=20, expected_date=MONDAY - timedelta(days=12))]
        )
        ctx = line(item, scenario=Scenario(supplier_delay_days=10))
        assert ctx.ip == 55


class TestConstraints:
    def test_moq_applied_when_excess_cover_is_small(self):
        item = make_item(
            sourcing=Sourcing(supplier_id="S", lead_time_days=7, order_weekdays=[], moq=60, pack_size=12, unit_cost=8),
        )
        ctx = line(item)
        assert ctx.qty == 60
        assert "MOQ_APPLIED" in constraint_codes(ctx)
        assert "MOQ_CONFLICT" not in codes(ctx)

    def test_moq_conflict_is_blocking(self):
        item = make_item(
            sourcing=Sourcing(supplier_id="S", lead_time_days=7, order_weekdays=[], moq=500, pack_size=12, unit_cost=8),
        )
        ctx = line(item)
        assert ctx.qty == 504  # MOQ rounded up to a pack multiple
        blocking = [e for e in ctx.exceptions if e.severity == "blocking"]
        assert [e.code for e in blocking] == ["MOQ_CONFLICT"]

    def test_capacity_caps_order(self):
        item = make_item(policy=Policy(service_level=0.95, capacity_units=80))
        ctx = line(item)
        assert ctx.qty == 24  # room 80 - 55 = 25 -> 2 packs
        assert "CAPACITY_CAPPED" in constraint_codes(ctx)

    def test_discontinued_suppresses_order(self):
        ctx = line(make_item(lifecycle=Lifecycle(status="DISCONTINUED")))
        assert ctx.qty == 0
        assert ctx.fixed_zero
        assert "DISCONTINUED" in codes(ctx)

    def test_end_of_life_before_delivery_suppresses_order(self):
        ctx = line(make_item(lifecycle=Lifecycle(end_of_life_date=MONDAY + timedelta(days=5))))
        assert ctx.qty == 0
        assert "EOL_BEFORE_ARRIVAL" in codes(ctx)

    def test_zero_demand_orders_nothing(self):
        ctx = line(make_item(open_orders=[], inventory=InventoryBuckets(on_hand=0)), rate=0, demand_class="zero")
        assert ctx.order_up_to == 0
        assert ctx.qty == 0
        assert "ZERO_DEMAND" in codes(ctx)

    def test_intermittent_uses_discrete_quantile(self):
        item = make_item(open_orders=[], inventory=InventoryBuckets(on_hand=0))
        ctx = line(item, rate=0.5, vmr=2.0)
        # mu = 4, var = 2*4 + 0.25*1 = 8.25 -> negative binomial quantile, not normal
        assert ctx.mu == pytest.approx(4.0)
        sl = next(s for s in ctx.steps if s.key == "safety_stock")
        assert sl.inputs["distribution"] == "negative_binomial"
        assert ctx.order_up_to == 9


class TestScenarios:
    def test_longer_lead_time_raises_order(self):
        base = line(make_item())
        longer = line(make_item(), scenario=Scenario(lead_time_delta_days=7))
        assert longer.protection_days == base.protection_days + 7
        assert longer.qty > base.qty

    def test_service_level_override(self):
        base = line(make_item())
        higher = line(make_item(), scenario=Scenario(service_level=0.99))
        assert higher.order_up_to == math.ceil(80 + 2.326348 * math.sqrt(180))
        assert higher.order_up_to > base.order_up_to

    def test_projected_stockout_before_arrival(self):
        item = make_item(inventory=InventoryBuckets(on_hand=20), open_orders=[])
        res = to_item_result(line(item), [], None)
        codes_ = {e.code for e in res.explanation.exceptions}
        assert "PROJECTED_STOCKOUT_BEFORE_ARRIVAL" in codes_
        assert res.projected_stockout_date == MONDAY + timedelta(days=2)
