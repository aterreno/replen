"""Periodic-review order-up-to policy (R,S) with item-level constraints and a calculation trace.

Every number that influences the recommended quantity is recorded as a TraceStep, ConstraintApplied
or PlanException so the planner workbench can show exactly how the quantity was reached.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np

from .calendar import OrderCycle, order_cycle
from .contracts import (
    Analogue,
    ConstraintApplied,
    DailyPoint,
    DemandSource,
    Explanation,
    HistoryPoint,
    ItemResult,
    PlanException,
    PlanItem,
    ProjectionPoint,
    Scenario,
    SourceForecast,
    TraceStep,
)
from .distributions import NORMAL_THRESHOLD, demand_quantile, distribution_name, z_for_service_level
from .forecast import Series, SeriesForecast

HIGH_UNCERTAINTY_CV = 0.75
HISTORY_CHART_DAYS = 56
PROJECTION_TAIL_DAYS = 14

MODEL_DESCRIPTIONS = {
    "seasonal_ma": "recent level x weekday profile x yearly pattern x promo uplift",
    "sba": "intermittent-demand smoothing (Syntetos-Boylan)",
    "zero": "no demand in the last year",
    "analogue": "similar products' demand (new product)",
    "short_history_mean": "average of the short history available",
    "top_down": "location share of item-level demand",
}


def r3(x: float) -> float:
    return float(round(x, 3))


@dataclass
class SourceInput:
    source: DemandSource
    series: Series | None
    forecast: SeriesForecast
    promo_planned_in_period: bool = False


@dataclass
class LineContext:
    item: PlanItem
    as_of: date
    cycle: OrderCycle
    protection_days: int
    horizon: int
    sources: list[SourceInput]
    mean_daily: np.ndarray
    var_daily: np.ndarray
    mu: float
    variance: float
    service_level: float
    order_up_to: float
    safety_stock: float
    ip: float
    ip_on_hand: float
    receipts: dict[date, float]
    net_requirement: float
    qty: int
    avg_daily: float
    steps: list[TraceStep] = field(default_factory=list)
    constraints: list[ConstraintApplied] = field(default_factory=list)
    exceptions: list[PlanException] = field(default_factory=list)
    fixed_zero: bool = False
    upper_bound_units: int | None = None


def _exc(code: str, severity: str, message: str) -> PlanException:
    return PlanException(code=code, severity=severity, message=message)


def inventory_position(item: PlanItem, as_of: date, supplier_delay_days: int = 0):
    """Return (ip, on_hand_effective, receipts by date, steps inputs, exceptions)."""
    inv = item.inventory
    exceptions: list[PlanException] = []
    on_hand_eff = max(inv.on_hand, 0)
    if inv.on_hand < 0:
        exceptions.append(
            _exc(
                "NEGATIVE_STOCK",
                "warning",
                f"On-hand is {inv.on_hand}; treated as 0 for ordering (A-41). Request a stock count.",
            )
        )
    if inv.reserved > max(inv.on_hand, 0):
        exceptions.append(
            _exc(
                "RESERVED_EXCEEDS_ON_HAND",
                "warning",
                f"Reserved ({inv.reserved}) exceeds on-hand ({inv.on_hand}); position includes a backlog.",
            )
        )
    receipts: dict[date, float] = {}
    tomorrow = as_of + timedelta(days=1)
    if inv.in_transit > 0:
        receipts[tomorrow] = receipts.get(tomorrow, 0) + inv.in_transit
    counted = 0
    excluded = 0
    grace = item.policy.overdue_grace_days
    for o in item.open_orders:
        expected = o.expected_date + timedelta(days=supplier_delay_days)
        if expected < as_of:
            overdue = (as_of - expected).days
            if overdue > grace:
                excluded += o.quantity
                exceptions.append(
                    _exc(
                        "OVERDUE_PO_EXCLUDED",
                        "warning",
                        f"Open order {o.reference} ({o.quantity} units) is {overdue} days overdue, beyond the "
                        f"{grace}-day grace period; excluded from the position (A-42). Chase the supplier.",
                    )
                )
                continue
            exceptions.append(
                _exc(
                    "OVERDUE_PO_COUNTED",
                    "warning",
                    f"Open order {o.reference} ({o.quantity} units) is {overdue} days overdue; still counted "
                    f"within the {grace}-day grace period (A-42).",
                )
            )
            arrival = tomorrow
        else:
            arrival = max(expected, tomorrow)
        counted += o.quantity
        receipts[arrival] = receipts.get(arrival, 0) + o.quantity
    ip = on_hand_eff - inv.reserved + inv.in_transit + counted
    inputs = {
        "onHand": inv.on_hand,
        "onHandUsed": on_hand_eff,
        "reserved": inv.reserved,
        "inTransit": inv.in_transit,
        "onOrderCounted": counted,
        "onOrderExcluded": excluded,
        "damagedExcluded": inv.damaged,
        "returnsPendingExcluded": inv.returns_pending,
    }
    return float(ip), float(on_hand_eff - inv.reserved), receipts, inputs, exceptions


def build_line(
    item: PlanItem,
    as_of: date,
    sources: list[SourceInput],
    scenario: Scenario | None,
    pooled: SeriesForecast | None = None,
) -> LineContext:
    scenario = scenario or Scenario()
    lead = max(0, item.sourcing.lead_time_days + scenario.lead_time_delta_days)
    cycle = order_cycle(as_of, lead, item.sourcing.order_weekdays, item.sourcing.delivery_weekdays)
    P = cycle.protection_period_days(as_of)
    horizon = len(sources[0].forecast.mean)

    mean_daily = np.zeros(horizon)
    var_daily = np.zeros(horizon)
    mu = 0.0
    var_demand = 0.0
    for s in sources:
        mean_daily += s.forecast.mean
        var_daily += s.forecast.daily_variance()
        mu += s.forecast.window_mean(0, P)
        var_demand += s.forecast.window_variance(0, P)
    avg_daily = mu / P if P > 0 else 0.0
    sigma_l = item.sourcing.lead_time_std_days
    var_lt = (avg_daily**2) * (sigma_l**2)
    variance = var_demand + var_lt
    sl = scenario.service_level or item.policy.service_level

    steps: list[TraceStep] = []
    exceptions: list[PlanException] = []
    constraints: list[ConstraintApplied] = []

    steps.append(
        TraceStep(
            key="protection_period",
            label="Protection period",
            value=P,
            unit="days",
            formula="delivery after next order - planning date",
            inputs={
                "orderDate": cycle.order_date.isoformat(),
                "deliveryDate": cycle.delivery_date.isoformat(),
                "nextOrderDate": cycle.next_order_date.isoformat(),
                "nextDeliveryDate": cycle.next_delivery_date.isoformat(),
                "leadTimeDays": lead,
                "reviewPeriodDays": cycle.review_period_days(),
            },
        )
    )
    models = sorted({s.forecast.model for s in sources})
    steps.append(
        TraceStep(
            key="forecast_over_period",
            label="Forecast demand over protection period",
            value=r3(mu),
            unit="units",
            formula="sum of daily forecasts across demand sources",
            inputs={
                "sources": len(sources),
                "models": ",".join(models),
                "itemModel": pooled.model if pooled else None,
                "itemDemandClass": pooled.demand_class if pooled else None,
                "itemYearlySeasonality": bool(pooled.yearly) if pooled else None,
                "itemPromoUplift": r3(pooled.promo_uplift) if pooled and pooled.promo_uplift is not None else None,
                "avgDailyDemand": r3(avg_daily),
                "demandMultiplier": scenario.demand_multiplier,
            },
        )
    )
    sigma = math.sqrt(max(variance, 0.0))
    steps.append(
        TraceStep(
            key="demand_variability",
            label="Demand uncertainty over protection period (std dev)",
            value=r3(sigma),
            unit="units",
            formula="sqrt(demand noise + forecast level error + avg daily demand^2 x lead time std^2)",
            inputs={
                "demandVariance": r3(var_demand),
                "leadTimeVariance": r3(var_lt),
                "leadTimeStdDays": sigma_l,
            },
        )
    )

    dist = distribution_name(mu, variance)
    S = 0.0 if mu <= 0 else float(math.ceil(demand_quantile(mu, variance, sl) - 1e-9))
    ss = S - mu
    ss_inputs: dict[str, float | int | str | bool | None] = {"serviceLevel": sl, "distribution": dist}
    if mu >= NORMAL_THRESHOLD:
        ss_inputs["z"] = r3(z_for_service_level(sl))
        ss_formula = "z x std dev, rounded up with the order-up-to level"
    else:
        ss_formula = f"{dist} quantile at service level - forecast (slow-moving demand)"
    steps.append(
        TraceStep(
            key="safety_stock", label="Safety stock", value=r3(ss), unit="units", formula=ss_formula, inputs=ss_inputs
        )
    )
    steps.append(
        TraceStep(
            key="order_up_to",
            label="Order-up-to level",
            value=S,
            unit="units",
            formula="forecast over protection period + safety stock",
        )
    )
    if mu > 0 and sigma / mu > HIGH_UNCERTAINTY_CV:
        exceptions.append(
            _exc(
                "HIGH_UNCERTAINTY",
                "info",
                f"Demand uncertainty is high (std dev {sigma:.1f} vs forecast {mu:.1f}); safety stock is a large "
                "share of the order-up-to level.",
            )
        )

    ip, ip_on_hand, receipts, ip_inputs, ip_exc = inventory_position(item, as_of, scenario.supplier_delay_days)
    exceptions.extend(ip_exc)
    steps.append(
        TraceStep(
            key="inventory_position",
            label="Inventory position",
            value=ip,
            unit="units",
            formula="max(on-hand,0) - reserved + in-transit + counted on-order",
            inputs=ip_inputs,
        )
    )
    nr = max(0.0, S - ip)
    steps.append(
        TraceStep(
            key="net_requirement",
            label="Net requirement",
            value=r3(nr),
            unit="units",
            formula="max(0, order-up-to - inventory position)",
        )
    )

    exceptions.extend(_signal_exceptions(item, sources, pooled, cycle))

    ctx = LineContext(
        item=item,
        as_of=as_of,
        cycle=cycle,
        protection_days=P,
        horizon=horizon,
        sources=sources,
        mean_daily=mean_daily,
        var_daily=var_daily,
        mu=mu,
        variance=variance,
        service_level=sl,
        order_up_to=S,
        safety_stock=ss,
        ip=ip,
        ip_on_hand=ip_on_hand,
        receipts=receipts,
        net_requirement=nr,
        qty=0,
        avg_daily=avg_daily,
        steps=steps,
        constraints=constraints,
        exceptions=exceptions,
    )
    apply_item_constraints(ctx)
    return ctx


def _signal_exceptions(
    item: PlanItem, sources: list[SourceInput], pooled: SeriesForecast | None, cycle: OrderCycle
) -> list[PlanException]:
    out: list[PlanException] = []
    analogues = sorted({a[0] for s in sources if s.forecast.model == "analogue" for a in s.forecast.analogues})
    if analogues:
        out.append(
            _exc(
                "NEW_PRODUCT_ANALOGUE",
                "info",
                "New product: forecast from similar products " + ", ".join(analogues) + ".",
            )
        )
    missing = [
        f"{s.source.location_id}/{s.source.channel}"
        for s in sources
        if s.forecast.demand_class == "new" and s.forecast.model == "zero"
    ]
    if missing and not analogues:
        out.append(
            _exc(
                "NO_HISTORY_NO_ANALOGUE",
                "warning",
                "No usable history and no analogue found for "
                + ", ".join(missing)
                + "; forecast is zero. Set a manual forecast or check product attributes.",
            )
        )
    lc = item.lifecycle
    if lc.launch_date is not None and lc.launch_date >= cycle.next_delivery_date:
        out.append(
            _exc(
                "PRE_LAUNCH",
                "info",
                f"Launches {lc.launch_date.isoformat()}, after this protection period; launch stock is "
                "an allocation decision, not replenishment.",
            )
        )
    promo_planned = any(s.promo_planned_in_period for s in sources)
    uplift = pooled.promo_uplift if pooled is not None else None
    if promo_planned and not analogues and (uplift is None or uplift <= 1.0):
        out.append(
            _exc(
                "PROMO_WITHOUT_HISTORY",
                "warning",
                "A promotion is planned within the lead time but there is not enough promotion history "
                "to estimate uplift; no uplift applied. Add a planner uplift if needed.",
            )
        )
    classes = {s.forecast.demand_class for s in sources}
    if classes == {"zero"}:
        out.append(_exc("ZERO_DEMAND", "info", "No demand in the last year at any demand source."))
    elif pooled is not None and pooled.demand_class in ("intermittent", "lumpy"):
        out.append(
            _exc(
                "INTERMITTENT_DEMAND",
                "info",
                "Item-level demand is intermittent; slow-mover quantiles used for safety stock.",
            )
        )
    return out


def round_to_pack(nr: float, pack: int, threshold: float) -> int:
    if nr <= 0:
        return 0
    packs = nr / pack
    whole = math.floor(packs + 1e-9)
    frac = packs - whole
    if frac >= threshold - 1e-9 and frac > 1e-9:
        whole += 1
    return int(whole * pack)


def apply_item_constraints(ctx: LineContext) -> None:
    item = ctx.item
    pack = item.sourcing.pack_size
    lc = item.lifecycle

    if lc.status == "DISCONTINUED":
        ctx.constraints.append(
            ConstraintApplied(
                code="DISCONTINUED",
                before=r3(ctx.net_requirement),
                after=0,
                message="Product is discontinued; no replenishment. Remaining stock runs down.",
            )
        )
        ctx.exceptions.append(_exc("DISCONTINUED", "info", "Discontinued product: order suppressed."))
        ctx.qty = 0
        ctx.fixed_zero = True
        _final_step(ctx)
        return
    if lc.end_of_life_date is not None and lc.end_of_life_date <= ctx.cycle.delivery_date:
        ctx.constraints.append(
            ConstraintApplied(
                code="EOL_BEFORE_ARRIVAL",
                before=r3(ctx.net_requirement),
                after=0,
                message=f"End of life {lc.end_of_life_date.isoformat()} is on or before the delivery date "
                f"{ctx.cycle.delivery_date.isoformat()}; ordering would only create clearance stock.",
            )
        )
        ctx.exceptions.append(_exc("EOL_BEFORE_ARRIVAL", "info", "End of life before delivery: order suppressed."))
        ctx.qty = 0
        ctx.fixed_zero = True
        _final_step(ctx)
        return

    qty = round_to_pack(ctx.net_requirement, pack, item.policy.pack_round_up_threshold)
    if ctx.net_requirement > 0 and qty != ctx.net_requirement:
        ctx.constraints.append(
            ConstraintApplied(
                code="PACK_ROUNDING",
                before=r3(ctx.net_requirement),
                after=qty,
                message=f"Rounded to case pack of {pack} (round up when remainder >= "
                f"{item.policy.pack_round_up_threshold:.0%} of a pack, A-44).",
            )
        )
    ctx.steps.append(
        TraceStep(
            key="pack_rounding",
            label="After case-pack rounding",
            value=qty,
            unit="units",
            inputs={"packSize": pack, "roundUpThreshold": item.policy.pack_round_up_threshold},
        )
    )

    moq = item.sourcing.moq
    if moq > 0 and moq % pack:
        moq = math.ceil(moq / pack) * pack
    if 0 < qty < moq:
        extra = moq - qty
        cover = extra / ctx.avg_daily if ctx.avg_daily > 0 else math.inf
        limit = item.policy.max_moq_cover_days
        if cover <= limit:
            ctx.constraints.append(
                ConstraintApplied(
                    code="MOQ_APPLIED",
                    before=qty,
                    after=moq,
                    message=f"Raised to minimum order quantity {moq}; the extra {extra} units cover "
                    f"{cover:.1f} days, within the {limit}-day limit (A-43).",
                )
            )
        else:
            cover_txt = "indefinitely (no forecast demand)" if math.isinf(cover) else f"{cover:.0f} days"
            ctx.constraints.append(
                ConstraintApplied(
                    code="MOQ_CONFLICT",
                    before=qty,
                    after=moq,
                    message=f"Need is {qty} but minimum order quantity is {moq}; the extra {extra} units would "
                    f"cover {cover_txt}, beyond the {limit}-day limit.",
                )
            )
            ctx.exceptions.append(
                _exc(
                    "MOQ_CONFLICT",
                    "blocking",
                    f"MOQ conflict: order {moq} (excess cover {cover_txt}) or set 0 and accept stockout risk. "
                    "Planner decision required.",
                )
            )
        qty = moq
    ctx.steps.append(
        TraceStep(
            key="moq", label="After minimum order quantity", value=qty, unit="units", inputs={"moq": item.sourcing.moq}
        )
    )

    cap = item.policy.capacity_units
    if cap is not None:
        room = cap - max(ctx.ip, 0.0)
        room_packs = max(0, math.floor(room / pack + 1e-9)) * pack
        ctx.upper_bound_units = int(room_packs)
        if qty > room_packs:
            before = qty
            qty = int(room_packs)
            ctx.constraints.append(
                ConstraintApplied(
                    code="CAPACITY_CAPPED",
                    before=before,
                    after=qty,
                    message=f"Capped by location capacity of {cap} units (room for {room_packs} after position).",
                )
            )
            ctx.exceptions.append(
                _exc("CAPACITY_CAPPED", "warning", f"Order reduced from {before} to {qty} by capacity {cap}.")
            )
            if 0 < qty < moq or (qty == 0 and moq > 0 and before >= moq):
                ctx.exceptions.append(
                    _exc(
                        "CAPACITY_BELOW_MOQ",
                        "blocking",
                        f"Capacity room ({room_packs}) is below the minimum order quantity ({moq}).",
                    )
                )
        ctx.steps.append(
            TraceStep(
                key="capacity",
                label="After capacity limit",
                value=qty,
                unit="units",
                inputs={"capacityUnits": cap, "room": r3(room)},
            )
        )
    ctx.qty = qty
    _final_step(ctx)


def _final_step(ctx: LineContext) -> None:
    ctx.steps = [s for s in ctx.steps if s.key != "recommended"]
    ctx.steps.append(
        TraceStep(
            key="recommended",
            label="Recommended order quantity",
            value=ctx.qty,
            unit="units",
            inputs={"packs": ctx.qty // ctx.item.sourcing.pack_size if ctx.item.sourcing.pack_size else ctx.qty},
        )
    )


def set_quantity(ctx: LineContext, qty: int, constraint: ConstraintApplied | None, exc: PlanException | None) -> None:
    if constraint:
        ctx.constraints.append(constraint)
    if exc:
        ctx.exceptions.append(exc)
    ctx.qty = qty
    _final_step(ctx)


def _projection(ctx: LineContext, qty: int) -> tuple[list[ProjectionPoint], date | None, date | None]:
    days = min(ctx.horizon, ctx.protection_days + PROJECTION_TAIL_DAYS)
    stock_wo = ctx.ip_on_hand
    stock_w = ctx.ip_on_hand
    points: list[ProjectionPoint] = []
    stockout_wo: date | None = None
    stockout_w: date | None = None
    for h in range(days):
        d = ctx.as_of + timedelta(days=h)
        receipt = ctx.receipts.get(d, 0.0)
        stock_wo += receipt - ctx.mean_daily[h]
        stock_w += receipt - ctx.mean_daily[h]
        if d == ctx.cycle.delivery_date:
            stock_w += qty
        if stock_wo < 0 and stockout_wo is None:
            stockout_wo = d
        if stock_w < 0 and stockout_w is None:
            stockout_w = d
        points.append(ProjectionPoint(date=d, without_order=r3(stock_wo), with_order=r3(stock_w)))
    return points, stockout_wo, stockout_w


def _narrative(ctx: LineContext) -> str:
    item = ctx.item
    pack = item.sourcing.pack_size
    parts = []
    if ctx.qty > 0:
        parts.append(
            f"Order {ctx.qty} units ({ctx.qty // pack} x {pack}) on {ctx.cycle.order_date.isoformat()} "
            f"for delivery {ctx.cycle.delivery_date.isoformat()}."
        )
    else:
        parts.append("No order this cycle.")
    models = sorted({MODEL_DESCRIPTIONS[s.forecast.model] for s in ctx.sources})
    parts.append(
        f"Forecast demand until the delivery after next ({ctx.protection_days} days) is {ctx.mu:.1f} units "
        f"from {len(ctx.sources)} demand source(s), using {'; '.join(models)}."
    )
    if ctx.mu > 0:
        parts.append(
            f"Safety stock of {ctx.safety_stock:.1f} units for a {ctx.service_level:.0%} service level gives an "
            f"order-up-to level of {ctx.order_up_to:.0f}."
        )
    parts.append(f"Inventory position is {ctx.ip:.0f}, so the net requirement is {ctx.net_requirement:.1f}.")
    for c in ctx.constraints:
        parts.append(c.message)
    blocking = [e for e in ctx.exceptions if e.severity == "blocking"]
    if blocking:
        parts.append("Needs a planner decision: " + "; ".join(e.code for e in blocking) + ".")
    return " ".join(parts)


def to_item_result(ctx: LineContext, history: list[HistoryPoint], accuracy) -> ItemResult:
    projection, stockout_wo, _ = _projection(ctx, ctx.qty)
    if (
        stockout_wo is not None
        and stockout_wo < ctx.cycle.delivery_date
        and not any(e.code == "PROJECTED_STOCKOUT_BEFORE_ARRIVAL" for e in ctx.exceptions)
    ):
        ctx.exceptions.append(
            _exc(
                "PROJECTED_STOCKOUT_BEFORE_ARRIVAL",
                "warning",
                f"Projected to run out on {stockout_wo.isoformat()}, before this order can arrive on "
                f"{ctx.cycle.delivery_date.isoformat()}. Consider expediting or a transfer.",
            )
        )
    forecast_points = []
    for h in range(min(ctx.horizon, ctx.protection_days + PROJECTION_TAIL_DAYS)):
        m = float(ctx.mean_daily[h])
        v = float(ctx.var_daily[h])
        forecast_points.append(
            DailyPoint(
                date=ctx.as_of + timedelta(days=h),
                mean=r3(m),
                p10=r3(demand_quantile(m, v, 0.1)),
                p90=r3(demand_quantile(m, v, 0.9)),
            )
        )
    sources = []
    P = ctx.protection_days
    for s in ctx.sources:
        fc = s.forecast
        sources.append(
            SourceForecast(
                location_id=s.source.location_id,
                channel=s.source.channel,
                model=fc.model,
                demand_class=fc.demand_class,
                mean_over_period=r3(fc.window_mean(0, P)),
                variance_over_period=r3(fc.window_variance(0, P)),
                observed_days=fc.observed_days,
                censored_days=fc.censored_days,
                promo_uplift=r3(fc.promo_uplift) if fc.promo_uplift is not None else None,
                yearly_seasonality=fc.yearly,
                share_of_item_demand=r3(fc.share) if fc.share is not None else None,
                analogues=[Analogue(sku=a, similarity=sim, daily_rate=rate) for a, sim, rate in fc.analogues],
            )
        )
    dos = (ctx.ip + ctx.qty) / ctx.avg_daily if ctx.avg_daily > 0 else None
    return ItemResult(
        sku=ctx.item.sku,
        destination_location_id=ctx.item.destination_location_id,
        supplier_id=ctx.item.sourcing.supplier_id,
        order_date=ctx.cycle.order_date,
        expected_delivery_date=ctx.cycle.delivery_date,
        recommended_qty=ctx.qty,
        unconstrained_qty=r3(ctx.net_requirement),
        order_up_to=ctx.order_up_to,
        inventory_position=ctx.ip,
        safety_stock=r3(ctx.safety_stock),
        forecast_over_period=r3(ctx.mu),
        protection_period_days=ctx.protection_days,
        avg_daily_forecast=r3(ctx.avg_daily),
        days_of_supply_after_order=r3(dos) if dos is not None else None,
        projected_stockout_date=stockout_wo,
        explanation=Explanation(
            steps=ctx.steps,
            constraints=ctx.constraints,
            exceptions=ctx.exceptions,
            narrative=_narrative(ctx),
            sources=sources,
        ),
        history=history,
        forecast=forecast_points,
        projection=projection,
        accuracy=accuracy,
    )


def history_points(sources: list[SourceInput], as_of: date, days: int = HISTORY_CHART_DAYS) -> list[HistoryPoint]:
    points = []
    for k in range(days, 0, -1):
        d = as_of - timedelta(days=k)
        total = 0.0
        out_of_stock = 0
        ranged = 0
        for s in sources:
            if s.series is None:
                continue
            i = s.series.dates_index(d)
            if 0 <= i < len(s.series.units):
                total += float(s.series.units[i])
                ranged += 1
                out_of_stock += int(not s.series.observed[i])
        # Flag a day only when most sources were unavailable; one store out of stock barely dents total demand.
        points.append(HistoryPoint(date=d, units=r3(total), censored=ranged > 0 and out_of_stock * 2 > ranged))
    return points
