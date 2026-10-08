"""Plan orchestration: PlanRequest -> PlanResponse."""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import date, timedelta

import duckdb
import numpy as np

from . import __version__
from .analogue import analogue_forecast
from .contracts import (
    Accuracy,
    ConstraintApplied,
    OrderConstraint,
    OrderResult,
    PlanException,
    PlanItem,
    PlanRequest,
    PlanResponse,
    RunAccuracy,
)
from .forecast import Series, SeriesForecast, apply_lifecycle, bias, forecast_sources, seasonal_naive, wape
from .optimiser import OptLine, optimise_order
from .policy import LineContext, SourceInput, build_line, history_points, set_quantity, to_item_result
from .store import category_candidates, future_promos, load_series, product_attributes, write_forecasts

MIN_HORIZON = 56


def _analogue_for(
    con: duckdb.DuckDBPyConnection,
    item: PlanItem,
    series: Series,
    location_id: str,
    channel: str,
    as_of: date,
    horizon: int,
    promos: np.ndarray,
) -> SeriesForecast | None:
    attrs = product_attributes(con, item.sku)
    if attrs is None:
        return None
    start = as_of - timedelta(days=len(series.units))
    end = as_of - timedelta(days=1)

    def loader(sku: str) -> Series | None:
        return load_series(con, sku, location_id, channel, start, end)

    fc = analogue_forecast(attrs, category_candidates(con, attrs.category), loader, horizon, promos)
    if fc is not None:
        fc.observed_days = int(series.observed.sum())
        fc.censored_days = int((~series.observed).sum())
    return fc


def _backtest(item: PlanItem, series_list: list[Series], as_of: date, days: int) -> Accuracy | None:
    if days <= 0:
        return None
    cutoff = as_of - timedelta(days=days)
    hist = [s.truncate(cutoff - timedelta(days=1)) for s in series_list]
    if sum(int(h.observed.sum()) for h in hist) < 28 or len(hist[0].units) < 56:
        return None
    n = len(hist[0].units)
    promos = [s.promo[n : n + days] for s in series_list]
    fcs, _ = forecast_sources(hist, days, promos)
    if all(fc.demand_class == "new" for fc in fcs):
        return None
    f_total = np.zeros(days)
    a_total = np.zeros(days)
    n_total = np.zeros(days)
    lost = 0.0
    for s, h, fc in zip(series_list, hist, fcs, strict=True):
        actual = s.units[n : n + days]
        obs = s.observed[n : n + days]
        fc = apply_lifecycle(fc, cutoff, item.lifecycle.launch_date, item.lifecycle.end_of_life_date)
        f_total += np.where(obs, fc.mean, 0.0)
        a_total += np.where(obs, actual, 0.0)
        n_total += np.where(obs, seasonal_naive(h, days), 0.0)
        # Censored days after the series was first ranged are stockouts; before that the item was not sold there.
        first_ranged = int(np.argmax(s.observed)) if s.observed.any() else len(s.units)
        stockout = ~obs & (np.arange(n, n + days) >= first_ranged)
        lost += float(fc.mean[stockout].sum())
    return Accuracy(
        wape=_r(wape(f_total, a_total)),
        bias=_r(bias(f_total, a_total)),
        naive_wape=_r(wape(n_total, a_total)),
        actual_units=round(float(a_total.sum()), 3),
        abs_error=round(float(np.abs(f_total - a_total).sum()), 3),
        error=round(float((f_total - a_total).sum()), 3),
        lost_units_estimate=round(lost, 3),
    )


def _r(x: float | None) -> float | None:
    return None if x is None else round(x, 4)


def plan(request: PlanRequest, con: duckdb.DuckDBPyConnection) -> PlanResponse:
    t0 = time.perf_counter()
    timings: dict[str, float] = defaultdict(float)
    as_of = request.as_of_date
    scenario = request.scenario
    start = as_of - timedelta(days=request.history_days)
    end = as_of - timedelta(days=1)

    contexts: list[tuple[LineContext, list, Accuracy | None]] = []
    for item in request.items:
        lead = item.sourcing.lead_time_days + (scenario.lead_time_delta_days if scenario else 0)
        horizon = max(MIN_HORIZON, lead + 28 + 21)
        t = time.perf_counter()
        series_list = [
            load_series(con, item.sku, src.location_id, src.channel, start, end) for src in item.demand_sources
        ]
        promos_list = [
            future_promos(con, item.sku, src.location_id, src.channel, as_of, horizon) for src in item.demand_sources
        ]
        timings["load"] += time.perf_counter() - t
        t = time.perf_counter()
        fcs, pooled_fc = forecast_sources(series_list, horizon, promos_list)
        sources: list[SourceInput] = []
        for src, series, promos, fc in zip(item.demand_sources, series_list, promos_list, fcs, strict=True):
            if fc.demand_class == "new":
                fc = _analogue_for(con, item, series, src.location_id, src.channel, as_of, horizon, promos) or fc
            if scenario and scenario.demand_multiplier != 1.0:
                fc.mean = fc.mean * scenario.demand_multiplier
            fc = apply_lifecycle(fc, as_of, item.lifecycle.launch_date, item.lifecycle.end_of_life_date)
            sources.append(SourceInput(src, series, fc, promo_planned_in_period=bool(promos[: lead + 28].any())))
        timings["forecast"] += time.perf_counter() - t
        t = time.perf_counter()
        ctx = build_line(item, as_of, sources, scenario, pooled_fc)
        timings["policy"] += time.perf_counter() - t
        t = time.perf_counter()
        accuracy = _backtest(item, series_list, as_of, request.backtest_days)
        timings["backtest"] += time.perf_counter() - t
        contexts.append((ctx, history_points(sources, as_of), accuracy))

    # Order-level constraints
    t = time.perf_counter()
    constraint_by_key = {(c.supplier_id, c.destination_location_id): c for c in request.order_constraints}
    groups: dict[tuple[str, str, date], list[LineContext]] = defaultdict(list)
    for ctx, _, _ in contexts:
        groups[(ctx.item.sourcing.supplier_id, ctx.item.destination_location_id, ctx.cycle.order_date)].append(ctx)
    orders: list[OrderResult] = []
    for (supplier, dest, order_date), lines in sorted(groups.items()):
        oc = constraint_by_key.get((supplier, dest)) or OrderConstraint(
            supplier_id=supplier, destination_location_id=dest
        )
        orders.append(_apply_order_constraints(supplier, dest, order_date, lines, oc))
    timings["optimise"] += time.perf_counter() - t

    items = [to_item_result(ctx, hist, acc) for ctx, hist, acc in contexts]

    abs_err = sum(i.accuracy.abs_error for i in items if i.accuracy)
    err = sum(i.accuracy.error for i in items if i.accuracy)
    actual = sum(i.accuracy.actual_units for i in items if i.accuracy)
    naive_abs = sum(
        (i.accuracy.naive_wape or 0) * i.accuracy.actual_units for i in items if i.accuracy and i.accuracy.naive_wape
    )
    run_acc = RunAccuracy(
        wape=_r(abs_err / actual) if actual > 0 else None,
        bias=_r(err / actual) if actual > 0 else None,
        naive_wape=_r(naive_abs / actual) if actual > 0 else None,
        series_evaluated=sum(1 for i in items if i.accuracy),
    )

    if request.persist:
        t = time.perf_counter()
        rows = [
            (request.run_id, i.sku, i.destination_location_id, p.date, p.mean, p.p10, p.p90)
            for i in items
            for p in i.forecast
        ]
        acc_rows = [
            (
                request.run_id,
                i.sku,
                i.destination_location_id,
                as_of,
                i.accuracy.wape,
                i.accuracy.bias,
                i.accuracy.naive_wape,
                i.accuracy.actual_units,
                i.accuracy.abs_error,
                i.accuracy.error,
            )
            for i in items
            if i.accuracy
        ]
        write_forecasts(con, rows, acc_rows)
        timings["persist"] += time.perf_counter() - t

    timings["total"] = time.perf_counter() - t0
    return PlanResponse(
        engine_version=__version__,
        run_id=request.run_id,
        as_of_date=as_of,
        items=items,
        orders=orders,
        accuracy=run_acc,
        timings_ms={k: round(v * 1000, 2) for k, v in timings.items()},
    )


def _apply_order_constraints(
    supplier: str, dest: str, order_date: date, lines: list[LineContext], oc: OrderConstraint
) -> OrderResult:
    opt_lines = [
        OptLine(
            key=ctx.item.sku,
            target_units=ctx.qty,
            pack=ctx.item.sourcing.pack_size,
            unit_cost=ctx.item.sourcing.unit_cost,
            unit_margin=ctx.item.unit_price - ctx.item.sourcing.unit_cost,
            avg_daily=ctx.avg_daily,
            moq=ctx.item.sourcing.moq,
            upper_units=ctx.upper_bound_units,
            fixed_zero=ctx.fixed_zero,
            safety_units=int(round(max(ctx.safety_stock, 0.0))),
        )
        for ctx in lines
    ]
    result = optimise_order(opt_lines, oc.min_order_value, oc.budget)
    exceptions: list[PlanException] = []
    if result.status != "NOT_REQUIRED":
        for ctx in lines:
            new = result.units[ctx.item.sku]
            if new == ctx.qty:
                continue
            code, message = _order_reason(ctx.qty, new, result.place_order, oc)
            exc = None
            if code == "BUDGET_REDUCED":
                exc = PlanException(code=code, severity="warning", message=message)
            elif code == "ORDER_DEFERRED":
                exc = PlanException(code="ORDER_DEFERRED_BELOW_MOV", severity="warning", message=message)
            set_quantity(ctx, new, ConstraintApplied(code=code, before=ctx.qty, after=new, message=message), exc)
        if not result.place_order:
            exceptions.append(
                PlanException(
                    code="ORDER_DEFERRED_BELOW_MOV",
                    severity="warning",
                    message=f"Order deferred: value below supplier minimum {oc.min_order_value:.2f}.",
                )
            )
        if any(c.code == "BUDGET_REDUCED" for ctx in lines for c in ctx.constraints):
            exceptions.append(
                PlanException(
                    code="BUDGET_CONSTRAINED",
                    severity="warning",
                    message=f"Order reduced to fit budget {oc.budget:.2f}.",
                )
            )
    return OrderResult(
        supplier_id=supplier,
        destination_location_id=dest,
        order_date=order_date,
        expected_delivery_date=max(c.cycle.delivery_date for c in lines),
        total_units=sum(c.qty for c in lines),
        total_value=round(sum(c.qty * c.item.sourcing.unit_cost for c in lines), 2),
        solver_status=result.status,
        notes=result.notes,
        exceptions=exceptions,
    )


def _order_reason(before: int, after: int, placed: bool, oc: OrderConstraint) -> tuple[str, str]:
    if not placed:
        return (
            "ORDER_DEFERRED",
            f"Order deferred: topping up to the supplier minimum {oc.min_order_value:.2f} costs more than waiting.",
        )
    if after > before:
        return (
            "MOV_TOPUP",
            f"Raised from {before} to {after} to reach the supplier minimum order value {oc.min_order_value:.2f}.",
        )
    budget = f"{oc.budget:.2f}" if oc.budget is not None else "n/a"
    return ("BUDGET_REDUCED", f"Reduced from {before} to {after} to fit the order budget {budget}.")
