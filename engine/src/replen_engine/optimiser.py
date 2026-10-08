"""Order-level optimisation with OR-Tools CP-SAT.

Item-level quantities come from the closed-form policy. The solver runs only when constraints that
couple lines bind: supplier minimum order value (MOV) and order budget. It chooses pack counts per
line to minimise

    sum_i  margin_i * SHORTAGE_PENALTY * (0.4 * safety_shortfall_i + 1.0 * cycle_shortfall_i)  +  holding_i * excess_i

where shortfall/excess are measured against the item-level quantity. Cutting into the safety-stock part of
a line costs less than cutting into its expected demand, so budget cuts spread across lines before any one
line is cut to below forecast. holding_i is the cost of
carrying one unit for the days of cover it adds (unit cost x holding rate / 365 / avg daily demand).
A binary decision allows deferring the whole order when topping up to the MOV costs more than the
expected shortfall. The objective is a documented heuristic, not a full stochastic model (doc 06).
"""

from __future__ import annotations

from dataclasses import dataclass

from ortools.sat.python import cp_model

HOLDING_RATE = 0.25  # A-48
SHORTAGE_PENALTY = 1.0  # A-49
TOPUP_MAX_COVER_DAYS = 56
SCALE = 10_000


@dataclass
class OptLine:
    key: str
    target_units: int
    pack: int
    unit_cost: float
    unit_margin: float
    avg_daily: float
    moq: int
    upper_units: int | None
    fixed_zero: bool
    safety_units: int = 0


@dataclass
class OptResult:
    status: str
    place_order: bool
    units: dict[str, int]
    total_value: float
    notes: list[str]


def _value(lines: list[OptLine], units: dict[str, int]) -> float:
    return sum(line.unit_cost * units[line.key] for line in lines)


def optimise_order(lines: list[OptLine], min_order_value: float, budget: float | None) -> OptResult:
    targets = {line.key: (0 if line.fixed_zero else line.target_units) for line in lines}
    value = _value(lines, targets)
    mov_binding = 0 < value < min_order_value
    budget_binding = budget is not None and value > budget + 1e-9
    if not mov_binding and not budget_binding:
        return OptResult("NOT_REQUIRED", value > 0, targets, round(value, 2), [])
    if value == 0:
        return OptResult("NOT_REQUIRED", False, targets, 0.0, [])

    model = cp_model.CpModel()
    place = model.NewBoolVar("place")
    n: dict[str, cp_model.IntVar] = {}
    short: dict[str, cp_model.IntVar] = {}
    excess: dict[str, cp_model.IntVar] = {}
    value_terms = []
    objective = []
    for line in lines:
        t = targets[line.key]
        if line.fixed_zero:
            ub_packs = 0
        else:
            topup = int(TOPUP_MAX_COVER_DAYS * line.avg_daily) if line.avg_daily > 0 else 0
            ub_units = t + topup
            if line.upper_units is not None:
                ub_units = min(ub_units, line.upper_units)
            ub_units = max(ub_units, 0)
            ub_packs = ub_units // line.pack
            if t > 0 and t % line.pack == 0:
                ub_packs = max(ub_packs, t // line.pack)
        x = model.NewIntVar(0, ub_packs, f"n_{line.key}")
        n[line.key] = x
        model.Add(x <= ub_packs * place)
        if line.moq > 0 and ub_packs > 0:
            b = model.NewBoolVar(f"b_{line.key}")
            model.Add(x * line.pack >= line.moq * b)
            model.Add(x <= ub_packs * b)
        ss_part = min(max(line.safety_units, 0), max(t, 0))
        s_safety = model.NewIntVar(0, ss_part, f"ss_{line.key}")
        s_cycle = model.NewIntVar(0, max(t - ss_part, 0), f"sc_{line.key}")
        e = model.NewIntVar(0, ub_packs * line.pack, f"e_{line.key}")
        model.Add(s_safety + s_cycle >= t - x * line.pack)
        model.Add(e >= x * line.pack - t)
        short[line.key] = s_cycle
        excess[line.key] = e
        cost_pence = round(line.unit_cost * 100)
        value_terms.append(cost_pence * line.pack * x)
        w_short = max(line.unit_margin, 0.01) * SHORTAGE_PENALTY * SCALE
        holding_per_unit = line.unit_cost * HOLDING_RATE / 365.0 / max(line.avg_daily, 0.01)
        w_hold = max(1, round(holding_per_unit * SCALE))
        objective.append(round(0.4 * w_short) * s_safety + round(w_short) * s_cycle + w_hold * e)
    total_value = sum(value_terms)
    if min_order_value > 0:
        model.Add(total_value >= round(min_order_value * 100) * place)
    if budget is not None:
        model.Add(total_value <= round(budget * 100))
    model.Minimize(sum(objective))

    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.max_time_in_seconds = 5.0
    status = solver.Solve(model)
    status_name = solver.StatusName(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return OptResult(status_name, False, {k: 0 for k in targets}, 0.0, ["No feasible order under constraints."])
    units = {line.key: int(solver.Value(n[line.key])) * line.pack for line in lines}
    placed = bool(solver.Value(place))
    notes = []
    if mov_binding:
        notes.append(
            f"Order value {value:.2f} was below the supplier minimum {min_order_value:.2f}; "
            + ("topped up lowest-holding-cost lines." if placed else "deferring the order costs less than topping up.")
        )
    if budget_binding:
        notes.append(f"Order value {value:.2f} exceeded the budget {budget:.2f}; reduced lowest-margin lines first.")
    return OptResult(status_name, placed, units, round(_value(lines, units), 2), notes)
