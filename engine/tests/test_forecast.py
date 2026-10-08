import numpy as np
import pytest

from replen_engine.analogue import ProductAttributes, analogue_forecast, similarity
from replen_engine.forecast import (
    bias,
    classify,
    demand_shares,
    forecast_series,
    pool_series,
    promo_uplift,
    sba_rate,
    seasonal_naive,
    wape,
    weekday_indices,
    yearly_enabled,
)

from .conftest import make_series


class TestClassification:
    def test_smooth(self):
        assert classify(make_series([5] * 100)).demand_class == "smooth"

    def test_intermittent(self):
        p = classify(make_series([0, 0, 1] * 60))
        assert p.demand_class == "intermittent"
        assert p.adi == pytest.approx(3.0)
        assert p.cv2 == pytest.approx(0.0)

    def test_lumpy(self):
        p = classify(make_series([0, 0, 1, 0, 0, 10] * 30))
        assert p.demand_class == "lumpy"
        assert p.cv2 == pytest.approx((4.5 / 5.5) ** 2)

    def test_erratic(self):
        assert classify(make_series([1, 12] * 60)).demand_class == "erratic"

    def test_zero_demand(self):
        assert classify(make_series([0] * 200)).demand_class == "zero"

    def test_new_when_fewer_than_28_observed_days(self):
        obs = [False] * 180 + [True] * 20
        assert classify(make_series([3] * 200, observed=obs)).demand_class == "new"


class TestSba:
    def test_steady_intermittent_rate(self):
        rate, z, p = sba_rate(np.array([0, 0, 4] * 50, dtype=float))
        assert z == pytest.approx(4.0)
        assert p == pytest.approx(3.0)
        assert rate == pytest.approx(0.95 * 4 / 3)

    def test_no_demand(self):
        assert sba_rate(np.zeros(30))[0] == 0.0

    def test_intermittent_series_uses_sba(self):
        fc = forecast_series(make_series([0, 0, 4] * 120), 30)
        assert fc.model == "sba"
        assert fc.mean[0] == pytest.approx(0.95 * 4 / 3)


class TestSeasonalMa:
    def test_weekday_indices_recovered_with_shrinkage(self):
        week = [10, 10, 10, 10, 10, 20, 20]  # Mon..Sun
        s = make_series(week * 52)  # ends Sunday 2026-10-04, starts Monday
        idx = weekday_indices(s)
        # 52 observations per weekday, shrink factor 52/60
        assert idx[0] == pytest.approx(1 + (10 / (90 / 7) - 1) * 52 / 60, abs=1e-9)
        assert idx[5] == pytest.approx(1 + (20 / (90 / 7) - 1) * 52 / 60, abs=1e-9)
        assert idx.mean() == pytest.approx(1.0)

    def test_flat_series_forecasts_its_level(self):
        fc = forecast_series(make_series([5] * 400), 30)
        assert fc.model == "seasonal_ma"
        assert np.allclose(fc.mean, 5.0)
        assert fc.vmr == 1.0
        assert fc.level_rel_var == pytest.approx(1 / (5 * 28))
        assert not fc.yearly

    def test_censored_days_do_not_bias_forecast_down(self):
        units = np.full(400, 5.0)
        observed = np.ones(400, dtype=bool)
        units[-10:] = 0  # stockout: no sales recorded
        observed[-10:] = False
        fc = forecast_series(make_series(units, observed), 14)
        assert np.allclose(fc.mean, 5.0)
        assert fc.censored_days == 10

    def test_uncensored_zeros_would_bias(self):
        units = np.full(400, 5.0)
        units[-10:] = 0
        fc = forecast_series(make_series(units), 14)
        assert fc.mean[0] < 5.0

    def test_promo_uplift_estimated_and_shrunk(self):
        n = 365
        promo = np.zeros(n, dtype=bool)
        for start in range(20, n - 7, 56):
            promo[start : start + 7] = True
        units = np.where(promo, 25.0, 10.0)
        s = make_series(units, promo=promo)
        uplift, used = promo_uplift(s, np.ones(7))
        assert used == int(promo.sum())
        assert uplift == pytest.approx(1 + 1.5 * used / (used + 10))

    def test_planned_promo_raises_forecast(self):
        n = 365
        promo = np.zeros(n, dtype=bool)
        for start in range(20, n - 7, 56):
            promo[start : start + 7] = True
        s = make_series(np.where(promo, 25.0, 10.0), promo=promo)
        future = np.zeros(14, dtype=bool)
        future[7:] = True
        fc = forecast_series(s, 14, future)
        assert fc.mean[7] / fc.mean[0] == pytest.approx(fc.promo_uplift)
        assert fc.promo_uplift > 1.5

    def test_yearly_seasonality_detected_and_applied(self):
        t = np.arange(730)
        rng = np.random.default_rng(1)
        lam = 5 * (1 + 0.8 * np.sin(2 * np.pi * (t + 120) / 364))
        s = make_series(rng.poisson(lam).astype(float))
        fc = forecast_series(s, 120)
        assert fc.yearly
        # forecast should follow last year's shape: compare correlation with the true future profile
        future = 5 * (1 + 0.8 * np.sin(2 * np.pi * (np.arange(730, 850) + 120) / 364))
        assert np.corrcoef(fc.mean, future)[0, 1] > 0.9

    def test_no_yearly_on_flat_noise(self):
        rng = np.random.default_rng(2)
        y = rng.poisson(3, 730).astype(float)
        assert not yearly_enabled(y, np.ones(730, dtype=bool))

    def test_seasonal_intermittent_routed_to_seasonal_model(self):
        t = np.arange(730)
        rng = np.random.default_rng(3)
        lam = 0.05 + 2.0 * np.exp(-0.5 * ((((t + 100) % 364) - 182) / 30) ** 2)
        s = make_series(rng.poisson(lam).astype(float))
        assert classify(s).demand_class in ("intermittent", "lumpy")
        assert forecast_series(s, 30).model == "seasonal_ma"


class TestPooling:
    def test_shares_and_censored_imputation(self):
        a = make_series([4.0] * 100)
        b_units = np.array([4.0] * 100)
        b_obs = np.ones(100, dtype=bool)
        b_units[50] = 0
        b_obs[50] = False
        b = make_series(b_units, b_obs)
        shares = demand_shares([a, b])
        assert shares == pytest.approx([0.5, 0.5])
        pooled = pool_series([a, b], shares)
        assert pooled.units[50] == pytest.approx(8.0)  # A's 4 units / 0.5 share observed
        assert pooled.observed[50]

    def test_day_with_most_demand_censored_is_unobserved(self):
        a = make_series([9.0] * 50)
        b = make_series([1.0] * 50)
        a_obs = a.observed.copy()
        a_obs[10] = False
        a2 = make_series(np.where(a_obs, 9.0, 0.0), a_obs)
        shares = demand_shares([a2, b])
        pooled = pool_series([a2, b], shares)
        assert not pooled.observed[10]


class TestAccuracy:
    def test_wape_and_bias(self):
        f, a = np.array([10.0, 10.0]), np.array([8.0, 12.0])
        assert wape(f, a) == pytest.approx(0.2)
        assert bias(f, a) == pytest.approx(0.0)
        assert bias(np.array([12.0, 12.0]), a) == pytest.approx(0.2)

    def test_undefined_when_no_actuals(self):
        assert wape(np.ones(3), np.zeros(3)) is None
        assert bias(np.ones(3), np.zeros(3)) is None

    def test_seasonal_naive_repeats_last_week(self):
        s = make_series(list(range(1, 15)))
        assert list(seasonal_naive(s, 10)) == [8, 9, 10, 11, 12, 13, 14, 8, 9, 10]


class TestAnalogue:
    A = ProductAttributes("A", "Home", "Cushions", "Atelier", "teal", 25.0)

    def test_similarity(self):
        assert similarity(self.A, self.A) == 1.0
        other_brand = ProductAttributes("B", "Home", "Cushions", "Other", "teal", 25.0)
        assert similarity(self.A, other_brand) == pytest.approx(np.exp(-0.5))
        assert similarity(self.A, ProductAttributes("C", "Fashion", "Tops", "x", "y", 25.0)) == 0.0
        double_price = ProductAttributes("D", "Home", "Cushions", "Atelier", "teal", 50.0)
        assert similarity(self.A, double_price) == pytest.approx(np.exp(-np.log(2)))

    def test_weighted_average_of_analogues(self):
        target = ProductAttributes("NEW", "Home", "Cushions", "Atelier", "yellow", 25.0)
        cands = [
            ProductAttributes("A", "Home", "Cushions", "Atelier", "teal", 25.0),  # sim exp(-0.25)
            ProductAttributes("B", "Home", "Cushions", "Other", "yellow", 25.0),  # sim exp(-0.5)
        ]
        series = {"A": make_series([4.0] * 365), "B": make_series([2.0] * 365)}
        fc = analogue_forecast(target, cands, series.get, 10, np.zeros(10, dtype=bool))
        wa, wb = np.exp(-0.25), np.exp(-0.5)
        assert fc.model == "analogue"
        assert fc.mean[0] == pytest.approx((4 * wa + 2 * wb) / (wa + wb))
        assert [a[0] for a in fc.analogues] == ["A", "B"]
        assert fc.level_rel_var >= 0.25

    def test_no_analogue_with_insufficient_history(self):
        target = ProductAttributes("NEW", "Home", "Cushions", "Atelier", "yellow", 25.0)
        cands = [ProductAttributes("A", "Home", "Cushions", "Atelier", "teal", 25.0)]
        short = make_series([4.0] * 365, observed=[False] * 300 + [True] * 65)
        assert analogue_forecast(target, cands, {"A": short}.get, 10, np.zeros(10, dtype=bool)) is None
