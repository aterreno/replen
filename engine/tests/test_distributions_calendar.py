from datetime import date

import pytest

from replen_engine.calendar import next_weekday_on_or_after, order_cycle
from replen_engine.distributions import demand_quantile, distribution_name, z_for_service_level

MON = date(2026, 10, 5)


class TestQuantiles:
    def test_poisson_quantile_matches_hand_computed_cdf(self):
        # Poisson(2): P(<=4)=0.9473, P(<=5)=0.9834
        assert demand_quantile(2.0, 2.0, 0.95) == 5
        assert demand_quantile(2.0, 2.0, 0.94) == 4

    def test_negative_binomial_quantile_matches_hand_computed_cdf(self):
        # NB with mean 4, variance 8 -> r=4, p=0.5; P(<=8)=0.9270, P(<=9)=0.9539
        assert demand_quantile(4.0, 8.0, 0.95) == 9
        assert demand_quantile(4.0, 8.0, 0.92) == 8

    def test_variance_below_mean_falls_back_to_poisson(self):
        assert demand_quantile(2.0, 1.0, 0.95) == demand_quantile(2.0, 2.0, 0.95)
        assert distribution_name(2.0, 1.0) == "poisson"

    def test_normal_branch_for_large_means(self):
        assert demand_quantile(100.0, 400.0, 0.95) == pytest.approx(100 + 1.644854 * 20, abs=1e-4)
        assert distribution_name(100.0, 400.0) == "normal"

    def test_zero_mean_gives_zero(self):
        assert demand_quantile(0.0, 0.0, 0.99) == 0.0
        assert distribution_name(0.0, 0.0) == "none"

    def test_z_values(self):
        assert z_for_service_level(0.95) == pytest.approx(1.644854, abs=1e-6)
        assert z_for_service_level(0.5) == pytest.approx(0.0, abs=1e-12)


class TestCalendar:
    def test_next_weekday(self):
        assert next_weekday_on_or_after(MON, [1]) == MON
        assert next_weekday_on_or_after(MON, [4]) == date(2026, 10, 8)
        assert next_weekday_on_or_after(MON, None) == MON

    def test_twice_weekly_supplier(self):
        c = order_cycle(MON, 14, [1, 4], [1, 2, 3, 4, 5])
        assert (c.order_date, c.delivery_date) == (MON, date(2026, 10, 19))
        assert (c.next_order_date, c.next_delivery_date) == (date(2026, 10, 8), date(2026, 10, 22))
        assert c.review_period_days() == 3
        assert c.protection_period_days(MON) == 17

    def test_delivery_day_rolls_forward(self):
        # Order Monday, lead 7 lands Monday, supplier only delivers Tue/Thu
        c = order_cycle(MON, 7, [1, 2, 3, 4, 5], [2, 4])
        assert c.delivery_date == date(2026, 10, 13)
        assert c.effective_lead_time_days() == 8
        assert c.protection_period_days(MON) == 8

    def test_order_day_later_in_week(self):
        c = order_cycle(MON, 35, [3], [1, 3])
        assert c.order_date == date(2026, 10, 7)
        assert c.delivery_date == date(2026, 11, 11)
        assert c.protection_period_days(MON) == 44
