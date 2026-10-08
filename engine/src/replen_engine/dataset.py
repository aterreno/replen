"""Build a PlanRequest straight from the synthetic CSV files.

Used by engine tests and the `plan` CLI command. In the running system the API builds the request from
its own transactional data; this module mirrors that mapping so the engine can be tested in isolation.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date
from pathlib import Path

from .contracts import (
    DemandSource,
    InventoryBuckets,
    Lifecycle,
    OpenOrder,
    OrderConstraint,
    PlanItem,
    PlanRequest,
    Policy,
    Sourcing,
)


def _read(path: Path) -> list[dict[str, str]]:
    with path.open() as f:
        return list(csv.DictReader(f))


def _d(s: str) -> date | None:
    return date.fromisoformat(s) if s else None


def build_plan_request(directory: str | Path, as_of: date, run_id: str = "test-run", **kwargs) -> PlanRequest:
    d = Path(directory)
    products = {r["sku"]: r for r in _read(d / "products.csv")}
    suppliers = {r["supplier_id"]: r for r in _read(d / "suppliers.csv")}
    locations = _read(d / "locations.csv")
    item_locs = {(r["sku"], r["location_id"]): r for r in _read(d / "item_locations.csv")}
    inventory = {(r["sku"], r["location_id"]): r for r in _read(d / "inventory_snapshot.csv")}
    open_orders: dict[tuple[str, str], list[OpenOrder]] = defaultdict(list)
    for r in _read(d / "open_purchase_orders.csv"):
        open_orders[(r["sku"], r["destination_location_id"])].append(
            OpenOrder(reference=r["po_reference"], quantity=int(r["quantity"]), expected_date=_d(r["expected_date"]))
        )
    items = []
    for s in _read(d / "sourcing.csv"):
        sku, dest = s["sku"], s["destination_location_id"]
        p = products[sku]
        sup = suppliers[s["supplier_id"]]
        il = item_locs[(sku, dest)]
        inv = inventory[(sku, dest)]
        sources = [
            DemandSource(location_id=loc["location_id"], channel="store")
            for loc in locations
            if loc["type"] == "STORE" and loc["serving_dc_id"] == dest
        ]
        sources.append(DemandSource(location_id=dest, channel="online"))
        items.append(
            PlanItem(
                sku=sku,
                destination_location_id=dest,
                unit_price=float(p["unit_price"]),
                demand_sources=sources,
                sourcing=Sourcing(
                    supplier_id=s["supplier_id"],
                    lead_time_days=int(sup["lead_time_days"]),
                    lead_time_std_days=float(sup["lead_time_std_days"]),
                    order_weekdays=[int(x) for x in sup["order_weekdays"].split("|") if x],
                    delivery_weekdays=[int(x) for x in sup["delivery_weekdays"].split("|") if x] or None,
                    moq=int(s["moq"]),
                    pack_size=int(s["pack_size"]),
                    unit_cost=float(s["unit_cost"]),
                ),
                lifecycle=Lifecycle(
                    status=p["status"], launch_date=_d(p["launch_date"]), end_of_life_date=_d(p["end_of_life_date"])
                ),
                policy=Policy(
                    service_level=float(il["service_level"]),
                    capacity_units=int(il["capacity_units"]) if il["capacity_units"] else None,
                ),
                inventory=InventoryBuckets(
                    on_hand=int(inv["on_hand"]),
                    reserved=int(inv["reserved"]),
                    in_transit=int(inv["in_transit"]),
                    damaged=int(inv["damaged"]),
                    returns_pending=int(inv["returns_pending"]),
                ),
                open_orders=open_orders[(sku, dest)],
            )
        )
    constraints = [
        OrderConstraint(
            supplier_id=r["supplier_id"],
            destination_location_id=r["destination_location_id"],
            min_order_value=float(r["min_order_value"] or 0),
            budget=float(r["budget"]) if r["budget"] else None,
        )
        for r in _read(d / "order_constraints.csv")
    ]
    return PlanRequest(run_id=run_id, as_of_date=as_of, items=items, order_constraints=constraints, **kwargs)
