# H. Build versus buy

Every figure in this document is a planning assumption for discussion, not a quote. Vendor prices are not public; the ranges below are placeholders to be replaced by RFI responses. Engineering rates and cloud costs are order-of-magnitude estimates.

## Options

| Option | Description |
|---|---|
| Buy | License a suite (any of the vendors in [01-competitive-analysis.md](01-competitive-analysis.md)) for forecasting, replenishment and allocation; integrate with the legacy estate through a systems integrator. |
| Build | Develop Replen as designed here: independent engine, GCP-native, owned contracts. |
| Hybrid | Buy the forecasting and replenishment engine; build the integration layer, data platform, approval workflow and planner-facing controls on the patterns in this repository (ACLs, outbox, audit, contracts). |

## Five-year cost model (assumptions)

| Cost line | Buy | Build | Hybrid | Basis |
|---|---|---|---|---|
| Licence / subscription | GBP 1.0m to 3.0m per year | 0 | GBP 0.8m to 2.5m per year | Placeholder; enterprise SaaS for 300k SKUs, 40 stores (A-01, A-02). Replace with RFI. |
| Implementation and integration | GBP 3m to 8m over 18 to 24 months | GBP 1.5m to 3m (internal integration team plus integrator support) | GBP 2m to 5m | Integration with merchandising, WMS, OMS, ERP dominates in all options |
| Product engineering team | 4 FTE (integration, support) | 8 engineers, 2 data scientists, 1 designer, 1 PM for 2 years; 6 FTE run thereafter | 6 FTE | Blended GBP 110k per FTE-year (assumption) |
| Data science | Vendor-provided models; 1 analyst | 2 to 3 FTE from year 3 (the first two years are inside the team above) | 1 to 2 FTE | Model evaluation is needed in every option |
| GCP run cost | Data platform only, about GBP 150k per year | About GBP 250k to 400k per year | About GBP 200k per year | BigQuery storage and compute for 2.5m series, Cloud Run Jobs nightly, Cloud SQL HA, Pub/Sub; assumption, validate with a pricing calculator in M1 |
| Five-year indicative total | GBP 11m to 27m | GBP 8m to 11m | GBP 11m to 23m | Sum of the rows: 5 years of licence, team and run cost plus implementation |

## Qualitative comparison

| Factor | Buy | Build |
|---|---|---|
| Time to first value | 9 to 18 months typical for first category (vendor case studies cite phased rollouts) | About 3 months to shadow mode and 6 to live for one category, starting from this slice (doc 10) |
| Capability breadth on day one | High: allocation, MFP, promotions, space are available as modules | Low: the slice covers replenishment for one echelon |
| Forecast quality | Vendors claim tuned ML across many retailers; unverified without a bake-off on own data | Baselines are transparent but basic; needs 1 to 2 years of data science to match leading vendors on promotions and weather |
| Explainability and control | Varies; at least one vendor publishes traceability claims | Full: every step stored and shown |
| Data and contract ownership | Vendor schema and APIs; exit cost high | Owned |
| Delivery risk | Integration risk, vendor roadmap dependency | Execution risk, key-person risk in data science |
| Operations | Vendor runs the application; retailer runs integrations | Retailer runs everything (SRE on-call) |

## Recommendation

The build total is lowest only because it buys far less capability: it covers replenishment, not the allocation, MFP, promotion and space modules a suite includes. Compare like for like before reading anything into the totals.

Run a structured bake-off before committing. Concretely: shortlist two vendors and run the M1 shadow-mode harness from this repository against both and against the Replen baselines on the same category, with the same inventory replay simulation (doc 06). Decide on measured accuracy, simulated service and stock, integration effort, and total cost.

Without that evidence, the hybrid option is the lower-risk default: the integration layer, approval controls, audit and data platform are needed in every option and are where this repository already has working patterns; the forecasting engine is where vendors are most likely to hold an advantage that takes years to match. A full build is justified only if the bake-off shows vendor accuracy is not materially better on this retailer's data, or if contract ownership and explainability are weighted above breadth.
