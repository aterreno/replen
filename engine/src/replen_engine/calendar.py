"""Supplier order and delivery calendars."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta


def next_weekday_on_or_after(start: date, weekdays: list[int] | None) -> date:
    """First date >= start whose ISO weekday is in `weekdays`. Empty/None means any day."""
    if not weekdays:
        return start
    allowed = set(weekdays)
    for offset in range(7):
        d = start + timedelta(days=offset)
        if d.isoweekday() in allowed:
            return d
    raise ValueError(f"no valid weekday in {weekdays}")


@dataclass(frozen=True)
class OrderCycle:
    order_date: date
    delivery_date: date
    next_order_date: date
    next_delivery_date: date

    def review_period_days(self) -> int:
        return (self.next_order_date - self.order_date).days

    def effective_lead_time_days(self) -> int:
        return (self.delivery_date - self.order_date).days

    def protection_period_days(self, as_of: date) -> int:
        """Days from the planning date until the delivery after next.

        Inventory position plus this order must cover demand over [as_of, next_delivery_date).
        """
        return (self.next_delivery_date - as_of).days


def order_cycle(
    as_of: date,
    lead_time_days: int,
    order_weekdays: list[int] | None,
    delivery_weekdays: list[int] | None,
) -> OrderCycle:
    order_date = next_weekday_on_or_after(as_of, order_weekdays)
    delivery = next_weekday_on_or_after(order_date + timedelta(days=lead_time_days), delivery_weekdays)
    next_order = next_weekday_on_or_after(order_date + timedelta(days=1), order_weekdays)
    next_delivery = next_weekday_on_or_after(next_order + timedelta(days=lead_time_days), delivery_weekdays)
    return OrderCycle(order_date, delivery, next_order, next_delivery)
