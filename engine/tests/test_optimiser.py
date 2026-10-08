from replen_engine.optimiser import OptLine, optimise_order


def opt_line(key, target, cost=5.0, margin=5.0, avg=1.0, pack=1, moq=0, upper=None, fixed=False, safety=0):
    return OptLine(key, target, pack, cost, margin, avg, moq, upper, fixed, safety)


def test_not_required_when_constraints_slack():
    r = optimise_order([opt_line("A", 10)], min_order_value=10, budget=1000)
    assert r.status == "NOT_REQUIRED"
    assert r.units == {"A": 10}


def test_budget_cuts_lowest_margin_line_first():
    lines = [opt_line("A", 10, margin=10), opt_line("B", 10, margin=1)]
    r = optimise_order(lines, min_order_value=0, budget=75)
    assert r.status == "OPTIMAL"
    assert r.units == {"A": 10, "B": 5}
    assert r.total_value == 75


def test_budget_takes_safety_stock_before_cycle_stock():
    # Same margin; A's last 4 units are safety stock, B has none. Cut 4 units: should come from A's safety stock.
    lines = [opt_line("A", 10, safety=4), opt_line("B", 10, safety=0)]
    r = optimise_order(lines, min_order_value=0, budget=80)
    assert r.units == {"A": 6, "B": 10}


def test_mov_tops_up_fastest_mover():
    lines = [opt_line("A", 5, avg=10), opt_line("B", 5, avg=0.1)]
    r = optimise_order(lines, min_order_value=100, budget=None)
    assert r.place_order
    assert r.units == {"A": 15, "B": 5}
    assert r.total_value == 100


def test_defers_when_mov_unreachable():
    lines = [opt_line("A", 2, avg=0.01), opt_line("B", 2, avg=0.01)]
    r = optimise_order(lines, min_order_value=10_000, budget=None)
    assert not r.place_order
    assert r.units == {"A": 0, "B": 0}


def test_respects_moq_and_packs():
    lines = [opt_line("A", 24, pack=12, moq=24, margin=1), opt_line("B", 24, pack=12, margin=10)]
    r = optimise_order(lines, min_order_value=0, budget=5 * 30)
    # 150 budget = 30 units. B keeps 24 (higher margin); A cannot place 12 because MOQ is 24.
    assert r.units == {"A": 0, "B": 24}


def test_fixed_zero_lines_stay_zero():
    lines = [opt_line("A", 0, avg=50, fixed=True), opt_line("B", 4, avg=1)]
    r = optimise_order(lines, min_order_value=100, budget=None)
    assert r.units["A"] == 0


def test_deterministic():
    lines = [opt_line(k, 10, margin=m, avg=a) for k, m, a in [("A", 3, 2), ("B", 3, 2), ("C", 2, 5)]]
    runs = {tuple(sorted(optimise_order(lines, 0, 100).units.items())) for _ in range(5)}
    assert len(runs) == 1
