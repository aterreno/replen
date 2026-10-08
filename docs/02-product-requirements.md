# B. Product requirements and glossary

## Problem

A department-store retailer buys across fashion, home, furniture, electricals and seasonal ranges from thousands of suppliers into a few DCs that serve stores and online. Ordering today (assumed) mixes legacy system suggestions with spreadsheet adjustments; planners spend most of their time on lines that did not need them and too little on the ones that did, and nobody can reconstruct why a given order quantity was chosen.

## Outcomes and measures

| Outcome | Measure | Baseline source |
|---|---|---|
| Higher availability without more stock | In-stock rate, lost sales estimate, days of supply, stock holding at cost | Legacy system during shadow mode (M1) |
| Better forecasts | WAPE, bias, forecast value added versus naive and versus legacy | Rolling-origin backtest |
| Less planner time on routine lines | Share of proposals approved without edits; time from proposal to decision | Workbench telemetry |
| Every order explainable and controlled | 100% of POs traceable to an approved proposal, a calculation trace and a named approver | Audit log |
| Reliable hand-off to ERP | Zero unreconciled POs; approval-to-ERP p99 < 5 minutes | PO events |

## Users

| Persona | Needs | Authority (A-46) |
|---|---|---|
| Replenishment planner | Review exceptions, adjust, approve routine orders | Approve up to GBP 5,000 |
| Senior planner | Approve larger orders, coach planners | Up to GBP 50,000 |
| Head of replenishment | Policy, unlimited approval, audit | Unlimited |
| Viewer (buyer, finance, supply chain) | See proposals, POs, KPIs | Read only |
| Platform admin | Imports, runs, operations | No spend authority |
| Supplier (M3) | See and confirm POs, propose dates and quantities | Own orders only |

## Requirements

Status: S = implemented in the slice, P = partially, D = designed only, F = future milestone. Numbering follows the brief.

| # | Requirement | Acceptance criteria | Status |
|---|---|---|---|
| 1 | Unified inventory position | Buckets on-hand, reserved, in-transit, on-order, damaged, returns-pending, ATS and IP per SKU-location; negative on-hand clamped and flagged; overdue POs counted within grace then excluded | S |
| 2 | Forecast at SKU/location/channel/day | Daily forecast per source with P10/P90; seasonality, promotions, lifecycle, uncertainty; stockout days excluded | P: price and weather not modelled |
| 3 | New-product forecasting | Attribute-similarity analogues, listed to the planner; pre-launch items flagged | S |
| 4 | Replenishment proposals | (R, S) policy with lead time, review period from supplier calendars, service level, lead-time variability | S |
| 5 | Multi-echelon optimisation | DC demand from stores and online; GSM safety stock placement | P: pass-through only |
| 6 | Constraints | MOQ, case packs, supplier order and delivery days, capacity, budget, MOV (CP-SAT) | P: transport and cash limits not modelled |
| 7 | PO and TO lifecycle | Create on approval, submit to ERP idempotently, track status, retry; amendments and TOs | P: no amendments, no TOs |
| 8 | Allocation, launches, end-of-life, markdown-aware | End-of-life truncation, discontinued suppression, pre-launch flag | P |
| 9 | Supplier portal and exceptions | Supplier confirmation and counter-proposal | F (M3) |
| 10 | Planner workbench | Exception queue, calculation trace, charts, reason-coded overrides, approval controls, history | S |
| 11 | What-if simulation | Lead time, demand, service level, supplier delay on frozen inputs | S (basic); capacity scenarios F |
| 12 | AI assistant | Natural-language explanations grounded in traces, read-only | D |
| 13 | KPI dashboard | Availability, lost sales, bias, WAPE, turns, days of supply, stock holding, working capital, OTIF, with definitions | S on synthetic data |

Non-functional requirements (SLOs, security, DR, tenancy, observability) are in [04-architecture.md](04-architecture.md).

## Explicit non-goals

- Customer order orchestration (the OMS owns it; Replen only consumes reservations).
- Merchandise financial planning, assortment and space planning, pricing and markdown optimisation. Replen consumes their outputs (budgets, ranging, promotion calendar, prices).
- Autonomous spend. Any automation of approvals runs under a rule a named human created, and is audited.

## Glossary

| Term | Definition |
|---|---|
| ADI | Average inter-demand interval: observed days / days with demand. |
| Analogue | An existing product similar by attributes, whose demand informs a new product's forecast. |
| ATS (available to sell) | max(0, on-hand - reserved). |
| Backtest | Forecasting a past period with only the data available then, and comparing with what happened. |
| Bias | sum(forecast - actual) / sum(actual). Positive means over-forecasting. |
| Blocking exception | A condition the engine will not resolve on its own (MOQ conflict, capacity below MOQ); approval is disabled until a planner decides. |
| Calculation trace | The stored list of steps, inputs, constraints and exceptions behind a recommended quantity. |
| Case pack | The supplier's shipping unit; order quantities are multiples of it. |
| Censored demand | Days when the item was out of stock, so sales understate demand; excluded from fitting. |
| Cycle service level | Probability of not running out between one delivery and the next. |
| Demand class | Smooth, erratic, intermittent, lumpy, zero or new, from ADI and CV^2. |
| Demand source | A series feeding a destination's demand: a store's store channel or the DC's online channel. |
| Echelon | A level in the supply network (supplier, DC, store). |
| Escalation | Sending a proposal above one's own limit to a higher-authority approver; the escalator cannot approve it. |
| Final quantity | The planner-approved quantity of a line; equals the recommendation unless overridden with a reason. |
| Four-eyes | Two different people involved in a decision above a threshold. |
| Inventory position (IP) | max(on-hand, 0) - reserved + in-transit + counted on-order. |
| Lead time | Days from order to delivery, after rolling to the supplier's delivery days. |
| MOQ | Minimum order quantity per line. |
| MOV | Minimum order value for a whole supplier order. |
| On-order | Open purchase-order quantity not yet received (legacy and Replen POs). |
| Order proposal | A suggested order for one supplier, one destination and one order date; the unit of approval. |
| Order-up-to level (S) | Target inventory position: forecast over the protection period plus safety stock. |
| OTIF | Share of deliveries on or before the promised date and in full. |
| Protection period | Days from the planning date until the delivery that follows the next order; the order must cover demand over this window. |
| P10 / P90 | Daily demand quantiles: 10% / 90% chance of demand at or below the value. |
| Review period (R) | Days between order opportunities. |
| Safety stock | Order-up-to level minus expected demand over the protection period. |
| SBA | Syntetos-Boylan approximation of Croston's method for intermittent demand. |
| Superseded | A proposal replaced by a newer planning run before a decision. |
| Top-down share | Forecasting a sparse store series as its share of the item's total demand. |
| WAPE | sum abs(forecast - actual) / sum actual. |
| What-if | A simulation on a run's frozen inputs with overlays; never persisted. |
