# J. Vertical slice: status, benchmarks, limitations, next steps

## The flow that works end to end

1. Import synthetic products, suppliers, stores, the DC, sourcing, ranging, inventory, open POs and delivery history through the import API (admin role); sales history and promotions load into the analytical store.
2. A planner starts a planning run. The API freezes inputs into a contract-validated request; the engine forecasts every demand source, computes (R, S) recommendations with item and order constraints, backtests, and returns traces.
3. Proposals land in the exception-first work queue with explanations, charts and forecast inputs.
4. The planner resolves blocking lines, overrides with reason codes, runs what-ifs, and approves within limit or escalates.
5. Approval emits an event; purchasing creates the PO, submits it through the ERP adapter to the mock ERP, and records the ERP number.
6. Events (CloudEvents) are published from the outbox; every decision is in the hash-chained audit log; KPIs are computed with definitions.

`npm run e2e` proves this with the real engine, API, mock ERP and browser on an isolated stack.

## Running it

Prerequisites: Node 22.12+ (tested on 26), [uv](https://docs.astral.sh/uv/) (it fetches Python 3.13), about 1 GB of disk for dependencies and the Playwright browser. Docker is not required.

```bash
npm run setup          # npm install, uv sync, generate synthetic data, load DuckDB
npm run dev            # engine :8000, mock ERP :4100, API :4000, web :3000; seeds and plans on first start
npm test               # engine (pytest), API (vitest), mock ERP (node:test)
npm run typecheck
npx playwright install chromium   # once, for e2e
npm run e2e            # isolated stack on ports 18000/14100/14000/13000, API checks + browser tests
npm run benchmark      # engine throughput
```

Development sign-in users (synthetic, A-46): `planner.priya` and `planner.omar` (GBP 5,000), `senior.sam` (GBP 50,000), `head.hana` (unlimited), `viewer.vic` (read only), `admin.ada` (imports, no spend authority). To start over: stop `npm run dev`, delete `.data/`, start again.

## Hosted demo (Vercel)

The public showcase runs the same code as one Vercel project with three [services](https://vercel.com/docs/services) (`vercel.json`):

| Service | Root | Runtime | Reachable |
|---|---|---|---|
| `web` | `apps/web` | Next.js | Public (catch-all rewrite) |
| `api` | `apps/api` | NestJS, compiled by SWC, entry `server.js` | Private: only through the web service's binding (`REPLEN_API_URL`) |
| `engine` | `engine` | Python 3.13 FastAPI, entry `main:app`, dependencies from `pyproject.toml` via uv | Private: only through the API's binding (`ENGINE_URL`) |

Differences from the local stack, all switched by environment variables:

| Setting | Local | Hosted demo | Why |
|---|---|---|---|
| Database | PGlite | Neon Postgres via the Vercel Marketplace (`DATABASE_URL`) | Functions are stateless and scale to zero |
| `RELAY_MODE` | `interval` (timer) | `after-request`: drain the outbox after each response, kept alive with `waitUntil` | No background timers on serverless |
| `ERP_MODE` | `http` to `apps/mock-erp` | `simulated`: database-backed ERP simulator with the same idempotency contract and ACL payload | In-memory mocks are not shared across instances |
| `ENGINE_BOOTSTRAP` | off; DuckDB file from `npm run data` | `1`: regenerate the deterministic dataset into `/tmp` and load DuckDB on cold start | No data files shipped |
| `DEMO_MODE` | off | `1`: seed on first request, admin "Reset demo data", daily reset via Vercel Cron (`/api/cron/reset-demo`, `CRON_SECRET`) | Shared public data needs a way back to a clean state |

Everyone who visits shares one dataset and any role can be chosen at sign-in, which is intended for a synthetic demo and would not be acceptable with real data. The first request after the functions have scaled to zero takes several seconds (engine cold start, data generation).

## Simulated versus production-ready

| Area | In the slice | Production-ready? | Gap to production |
|---|---|---|---|
| Data | Deterministic synthetic dataset (33 SKUs, 5 stores, 1 DC, 6 suppliers, 2 years), SHA-256 manifest checked in tests | Synthetic only | Real extracts through ACLs (stage 0, doc 09) |
| Legacy feeds | CSV extract mapped by `legacy-csv.ts`, posted to `/imports` | Pattern only | File/event ingestion on GCS and Pub/Sub, schema validation, reconciliation |
| Analytical store | DuckDB file standing in for BigQuery | No | BigQuery adapter for `store.py`; Dataform transformations |
| Transactional store | PGlite (in-process Postgres 17) for tests and local dev; node-postgres adapter tested over the wire protocol | Adapter yes, operations no | Cloud SQL, connection pooling under concurrency, backups, migrations pipeline |
| Engine | FastAPI on demand; synchronous call from the API | Logic yes, scale no | Cloud Run Jobs sharding, GCS hand-off, bulk history reads |
| Forecasting | Baselines with censoring, pooling, seasonality, promo uplift, analogues, quantiles, backtest | Baseline quality | Rolling-origin evaluation, challengers, price/weather/events (doc 06) |
| Replenishment | (R, S) with calendars, lead-time variance, packs, MOQ, capacity, lifecycle; CP-SAT for MOV and budget | Yes for single echelon | Fill-rate targets, transport constraints, multi-echelon |
| Events | Outbox, relay, inbox, ordering, dead-lettering, JSON Schema validation; publisher writes NDJSON | Semantics yes | Pub/Sub publisher and push subscriptions, DLQ topics |
| ERP | Mock ERP with idempotency and failure injection; HTTP ACL adapter; backoff retries | Pattern yes | Real ERP contract, credentials in Secret Manager, reconciliation job |
| Identity | HMAC dev tokens, roles, approval limits, four-eyes | No | IAP and workforce identity federation; limits managed by an admin workflow |
| Audit | Append-only trigger, hash chain, verification endpoint | Yes in design | Periodic anchoring of the chain head outside the database; export to BigQuery |
| Web | Next.js workbench with BFF proxy and httpOnly session cookie | Feature-complete for the slice | IAP, accessibility audit, load testing |
| Infrastructure | Local scripts only | No | Terraform for projects, Cloud Run, Cloud SQL, BigQuery, Pub/Sub, VPC-SC; container images; CI/CD |

## Test inventory

| Suite | Count | What it proves |
|---|---|---|
| Engine (pytest) | 99 | Quantile maths against hand-computed CDFs; calendars; classification; SBA; weekday and promo estimation; yearly seasonality detection; censoring; pooling; analogues; the worked (R, S) example; pack, MOQ, capacity, lifecycle, negative stock, overdue POs, zero and intermittent demand; optimiser budget, MOV, MOQ, deferral and determinism; every planted edge case in the synthetic data; golden quantities; generator determinism; contract drift; HTTP API |
| API (vitest, PGlite) | 45 | Full slice through HTTP with recorded engine output: imports, run, exception ordering, traces, override validation, version conflicts, roles, approval limits, escalation and four-eyes, idempotent approval, async PO creation, duplicate event delivery, ERP failure and retry, rejection, supersession, what-if, event contracts and per-aggregate ordering, audit trail and tamper detection, KPIs, OpenAPI response validation, relay ordering and dead-lettering, engine failure, HTTP ERP adapter against the mock ERP, node-postgres adapter |
| Mock ERP (node:test) | 3 | Idempotency, validation, failure injection |
| E2E (Playwright + script) | 5 browser tests, 10 checks | Real engine, API, mock ERP and browser together; quantities in the ERP match the approved PO; correlation id flows; audit verifies |

## Benchmarks

Measured on an Apple Silicon laptop (arm64, 10 cores, 64 GB), single process. Treat as indicative.

| Measurement | Result |
|---|---|
| Engine forecast throughput, in-memory, 730-day history, 20,000 mixed series | 1,407 series per second per core |
| Engine policy (R, S) throughput | 26,600 lines per second per core |
| Planning run, 33 items / 198 series, real engine, end to end through the API | 0.65 to 0.72 s (engine 0.61 to 0.69 s: DuckDB reads 0.16 s, forecast 0.10 s, backtest 0.04 s, policy 4 ms, optimiser 14 to 32 ms, forecast persistence 0.28 to 0.31 s) |
| Approval to ERP acknowledgement (relay interval 200 ms) | 223 ms |
| E2E suite including stack start and browser tests | 11.8 s |

Extrapolation to the sizing assumption (A-06, 2.5 million series), not measured: forecasting alone is about 30 core-minutes, doubled with backtesting; across 50 Cloud Run Jobs tasks that is a few minutes of compute per night, so I/O (reading history, writing forecasts) will dominate. Two known hot spots before that matters: per-series DuckDB queries (bulk reads needed) and row-by-row forecast inserts (0.3 s for 33 items; needs Arrow or bulk loads), plus a Python loop in the residual variance calculation that can be vectorised.

## Technical limitations

- The engine is called synchronously from the API; a run that took minutes would hold an HTTP request. Fine for the slice, wrong for production (doc 04 sequence).
- One planning run writes all proposals in one transaction; at scale this becomes one transaction per proposal with the run marked complete at the end.
- DuckDB allows one writing process: stop the engine before re-importing history.
- PGlite is single-connection; local dev cannot exercise concurrent writers. The node-postgres adapter test uses a single-session wire server, so transaction isolation under concurrency is not covered.
- The relay and the ERP submission run in the API process; a slow ERP slows event dispatch. Production moves submission to push subscriptions or Cloud Tasks.
- Store inventory in the synthetic data is coarse (several sparse SKUs have zero store stock), so the store in-stock KPI is low; it reflects the generator, not the method.
- Forecast accuracy figures are from synthetic data generated by the processes the models assume; real data will score worse.
- The web app has no automated accessibility checks and has not been tested on narrow screens.

## Remaining gaps and next steps

In priority order for M1 (doc 10):

1. GCP landing zone and Terraform: projects per environment, Cloud Run services and jobs, Cloud SQL, BigQuery datasets, Pub/Sub topics with DLQs, VPC-SC, Artifact Registry; CI building and scanning images.
2. BigQuery adapter for the engine store and an asynchronous run path (Workflows, sharded Cloud Run Jobs, GCS hand-off, `run.completed` ingestion).
3. Real data feeds for one category through the ACLs, with reconciliation reports.
4. Evaluation harness: rolling-origin backtests and inventory replay simulation; legacy and `ARIMA_PLUS` as comparators.
5. Pub/Sub publisher and push subscription endpoint with OIDC verification; Cloud Tasks for ERP submission.
6. IAP and workforce identity; approval-limit administration with audit.
7. `ordering_owner` flag and shadow mode switch (proposals generated, ERP adapter disabled per scope).
8. Then M2: real ERP adapter, PO amendments and cancellations, receipts updating on-order, transport constraints, read-only assistant, standing approval rules.
