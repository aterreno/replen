"""Engine request/response contract (v1).

The committed JSON Schemas in contracts/engine/ are generated from these models
(`replen-engine export-schemas`). A test fails if the models drift from the committed files,
so any change here must be deliberate and regenerated.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

CONTRACT_VERSION = "1.0.0"


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Channel = Literal["store", "online"]
LifecycleStatus = Literal["ACTIVE", "NEW", "DISCONTINUED"]
Severity = Literal["info", "warning", "blocking"]
DemandClass = Literal["smooth", "erratic", "intermittent", "lumpy", "zero", "new"]
ForecastModel = Literal["seasonal_ma", "sba", "top_down", "zero", "analogue", "short_history_mean"]


class DemandSource(Model):
    """A series whose demand this destination must supply (store channel at a store, online at a DC)."""

    location_id: str
    channel: Channel


class OpenOrder(Model):
    reference: str
    quantity: int = Field(ge=0)
    expected_date: date


class InventoryBuckets(Model):
    on_hand: int
    reserved: int = Field(default=0, ge=0)
    in_transit: int = Field(default=0, ge=0)
    damaged: int = Field(default=0, ge=0)
    returns_pending: int = Field(default=0, ge=0)


class Sourcing(Model):
    supplier_id: str
    lead_time_days: int = Field(ge=0)
    lead_time_std_days: float = Field(default=0.0, ge=0)
    order_weekdays: list[int] = Field(description="ISO weekdays 1=Mon..7=Sun on which orders can be placed")
    delivery_weekdays: list[int] | None = Field(default=None, description="ISO weekdays the supplier delivers")
    moq: int = Field(default=0, ge=0)
    pack_size: int = Field(default=1, ge=1)
    unit_cost: float = Field(ge=0)


class Lifecycle(Model):
    status: LifecycleStatus = "ACTIVE"
    launch_date: date | None = None
    end_of_life_date: date | None = None


class Policy(Model):
    service_level: float = Field(gt=0, lt=1)
    max_moq_cover_days: int = Field(default=28, ge=0)
    pack_round_up_threshold: float = Field(default=0.25, ge=0, le=1)
    overdue_grace_days: int = Field(default=7, ge=0)
    capacity_units: int | None = Field(default=None, ge=0)


class PlanItem(Model):
    sku: str
    destination_location_id: str
    unit_price: float = Field(ge=0)
    demand_sources: list[DemandSource] = Field(min_length=1)
    sourcing: Sourcing
    lifecycle: Lifecycle = Lifecycle()
    policy: Policy
    inventory: InventoryBuckets
    open_orders: list[OpenOrder] = []


class OrderConstraint(Model):
    supplier_id: str
    destination_location_id: str
    min_order_value: float = Field(default=0, ge=0)
    budget: float | None = Field(default=None, ge=0)


class Scenario(Model):
    """What-if overlays. Applied on top of the item inputs; never persisted by the engine."""

    lead_time_delta_days: int = 0
    demand_multiplier: float = Field(default=1.0, gt=0)
    service_level: float | None = Field(default=None, gt=0, lt=1)
    supplier_delay_days: int = Field(default=0, ge=0, description="Shifts all open orders later")


class PlanRequest(Model):
    contract_version: str = CONTRACT_VERSION
    run_id: str
    as_of_date: date
    history_days: int = Field(default=730, ge=28, le=1460)
    backtest_days: int = Field(default=28, ge=0, le=91)
    persist: bool = True
    items: list[PlanItem]
    order_constraints: list[OrderConstraint] = []
    scenario: Scenario | None = None


# ---------- response ----------


class TraceStep(Model):
    key: str
    label: str
    value: float
    unit: str
    formula: str | None = None
    inputs: dict[str, float | int | str | bool | None] = {}


class ConstraintApplied(Model):
    code: str
    before: float
    after: float
    message: str


class PlanException(Model):
    code: str
    severity: Severity
    message: str


class Analogue(Model):
    sku: str
    similarity: float
    daily_rate: float


class SourceForecast(Model):
    location_id: str
    channel: Channel
    model: ForecastModel
    demand_class: DemandClass
    mean_over_period: float
    variance_over_period: float
    observed_days: int
    censored_days: int
    promo_uplift: float | None = None
    yearly_seasonality: bool = False
    share_of_item_demand: float | None = None
    analogues: list[Analogue] = []


class DailyPoint(Model):
    date: date
    mean: float
    p10: float
    p90: float


class HistoryPoint(Model):
    date: date
    units: float
    censored: bool = Field(description="True when more than half of the demand sources were out of stock that day")


class ProjectionPoint(Model):
    date: date
    without_order: float
    with_order: float


class Accuracy(Model):
    wape: float | None
    bias: float | None
    naive_wape: float | None
    actual_units: float
    abs_error: float
    error: float
    lost_units_estimate: float = Field(
        default=0.0, description="Forecast demand on censored (out-of-stock) days in the backtest window"
    )


class Explanation(Model):
    steps: list[TraceStep]
    constraints: list[ConstraintApplied]
    exceptions: list[PlanException]
    narrative: str
    sources: list[SourceForecast]


class ItemResult(Model):
    sku: str
    destination_location_id: str
    supplier_id: str
    order_date: date
    expected_delivery_date: date
    recommended_qty: int
    unconstrained_qty: float
    order_up_to: float
    inventory_position: float
    safety_stock: float
    forecast_over_period: float
    protection_period_days: int
    avg_daily_forecast: float
    days_of_supply_after_order: float | None
    projected_stockout_date: date | None
    explanation: Explanation
    history: list[HistoryPoint]
    forecast: list[DailyPoint]
    projection: list[ProjectionPoint]
    accuracy: Accuracy | None = None


class OrderResult(Model):
    supplier_id: str
    destination_location_id: str
    order_date: date
    expected_delivery_date: date
    total_units: int
    total_value: float
    solver_status: str
    notes: list[str]
    exceptions: list[PlanException]


class RunAccuracy(Model):
    wape: float | None
    bias: float | None
    naive_wape: float | None
    series_evaluated: int


class PlanResponse(Model):
    contract_version: str = CONTRACT_VERSION
    engine_version: str
    run_id: str
    as_of_date: date
    items: list[ItemResult]
    orders: list[OrderResult]
    accuracy: RunAccuracy
    timings_ms: dict[str, float]
