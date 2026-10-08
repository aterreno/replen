# Assumption register

Every business figure, volume and interface in this repository is an assumption until validated with the retailer. None of these values come from any real retailer. IDs are referenced from the other documents.

Status values: `unvalidated` (default), `validated` (confirmed by a named owner, with date), `rejected`.

## Business scale

| ID | Assumption | Value used for sizing | Status |
|---|---|---|---|
| A-01 | Active sellable SKUs (including size/colour variants) | 300,000 | unvalidated |
| A-02 | Stores | 40 | unvalidated |
| A-03 | Distribution centres (including one online fulfilment DC) | 3 | unvalidated |
| A-04 | Average stores ranged per store-replenished SKU | 12 | unvalidated |
| A-05 | Share of SKUs replenished (rest are one-shot allocated fashion/seasonal buys) | 55% | unvalidated |
| A-06 | Forecast series (SKU x location x channel) | about 2.5 million | derived from A-01..A-05 |
| A-07 | Daily forecast horizon | 120 days | unvalidated |
| A-08 | Active suppliers | 3,000 | unvalidated |
| A-09 | Planners and approvers using the workbench | 150 named, 60 concurrent peak | unvalidated |
| A-10 | Order proposal lines needing a non-zero order per day | 5% of DC SKU-locations, about 25,000 lines | unvalidated |
| A-11 | Purchase orders created per day | 1,500 | unvalidated |

## Interfaces

| ID | Assumption | Status |
|---|---|---|
| A-20 | Legacy merchandising system publishes product, supplier, sourcing and cost master data as a nightly full extract plus intraday deltas (file or message) | unvalidated |
| A-21 | Store and DC stock positions are available as a nightly snapshot plus intraday movement feed from WMS and store inventory systems | unvalidated |
| A-22 | Sales history is available at SKU x location x channel x day, net of returns, without customer identifiers | unvalidated |
| A-23 | The ERP accepts purchase orders through an API or middleware queue, returns an ERP PO number, and supports a client-supplied idempotency key or reference | unvalidated; the mock ERP implements this contract |
| A-24 | Supplier confirmations and ASNs arrive via EDI (EDIFACT ORDRSP/DESADV) or a portal, translated by existing middleware | unvalidated |
| A-25 | Customer order reservations are published by the OMS as a reserved-quantity feed per SKU-location; Replen never orchestrates customer orders | unvalidated |
| A-26 | Promotion calendar and planned prices come from the pricing/promotions system with at least 4 weeks' notice | unvalidated |

## Planning rules

| ID | Assumption | Default in slice | Status |
|---|---|---|---|
| A-40 | Target cycle service level by category | Electricals 0.97, Home 0.95, Fashion basics 0.95, Furniture 0.90, Seasonal 0.92 | unvalidated |
| A-41 | Negative on-hand is a data timing error; treat as zero for ordering and raise an exception | clamp to 0 | unvalidated |
| A-42 | Overdue purchase orders still count towards on-order for a grace period, then are excluded | 7 days | unvalidated |
| A-43 | MOQ may be accepted automatically if the extra stock covers at most N days of forecast demand beyond the order-up-to level | 28 days | unvalidated |
| A-44 | Case-pack rounding rounds up when the remainder is at least this fraction of a pack | 0.25 | unvalidated |
| A-45 | Stores are replenished from DCs; DC demand equals store demand plus online demand (echelon pass-through) | used in slice | simplification, see doc 06 |
| A-46 | Approval limits per role (order value) | Planner GBP 5,000; Senior planner GBP 50,000; Head of replenishment unlimited | unvalidated |
| A-47 | Days with zero on-hand at open are censored: they are removed from model fitting | used in slice | unvalidated |
| A-48 | Holding cost rate per year as a share of unit cost | 25% | unvalidated |
| A-49 | Shortage penalty used by the order-level optimiser, as a multiple of unit margin | 1.0 | unvalidated |

## Platform

| ID | Assumption | Status |
|---|---|---|
| A-60 | Primary region europe-west2 (London); DR region europe-west1 (Belgium) is acceptable for data residency | unvalidated; legal review required |
| A-61 | Each retailer tenant gets its own GCP project set (silo tenancy) | design decision, see doc 04 |
| A-62 | Planner identity comes from the retailer's workforce IdP via Workforce Identity Federation and IAP | unvalidated |
| A-63 | Nightly planning window: data cut-off 01:00, proposals ready by 05:00 UK time | unvalidated |
