# Milestone plan

Each milestone ends with working software in front of real users or real data. No milestone depends on switching a legacy system off. Durations are planning estimates for a team of about 8 engineers, 2 data scientists and 1 product designer; they are assumptions, not commitments.

| Milestone | Scope | Exit criteria | Estimate |
|---|---|---|---|
| M0 Vertical slice (this repository) | Synthetic data import, baseline forecast, (R,S) recommendation with constraints and trace, planner workbench, override and approval, PO via mock ERP, events, audit, KPIs | All tests green; end-to-end flow runs on a laptop without cloud access; gaps documented | Done: 147 automated tests plus browser e2e pass; see [11-vertical-slice.md](11-vertical-slice.md) |
| M1 Shadow mode on one category | GCP landing zone; real extracts for one category and one DC through the ACL; nightly Cloud Run Job; proposals visible to planners but not sent to ERP; side-by-side comparison with legacy orders | 8 weeks of shadow proposals; WAPE and bias reported against the legacy forecast; planner feedback on traces | 12 weeks |
| M2 Live ordering for the pilot category | Real ERP adapter (non-mock) behind a feature flag per supplier; IAP and workforce identity; Pub/Sub; global ML forecast model as challenger; vehicle fill constraint; assistant (read-only) | First live POs; zero unreconciled POs between Replen and ERP for 4 weeks; rollback to legacy within one planning cycle demonstrated | 12 weeks |
| M3 Network depth | Store replenishment from DC (transfer orders); guaranteed-service multi-echelon targets; supplier confirmation API and portal; what-if scenarios persisted and shareable | Store availability KPI at or above legacy for pilot stores; supplier confirmation latency measured | 16 weeks |
| M4 Lifecycle and seasonal | New-season launch allocation, end-of-life run-down, markdown hand-off to pricing, fashion one-shot buys | One season planned end to end in Replen for the pilot category | 16 weeks |
| M5 Scale-out | Category-by-category migration (doc 09); performance hardening for 2.5 million series; DR test | Each migrated category passes the same shadow-then-live gates as M1-M2 | Rolling |
