# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run setup                      # npm install + uv sync + generate synthetic data + load DuckDB
npm run dev                        # engine :8000, mock ERP :4100, API :4000 (PGlite in .data/pglite), web :3000
npm test                           # engine pytest + API vitest + mock ERP node:test
npm run typecheck                  # tsc across workspaces
npm run e2e                        # isolated stack on 18000/14100/14000/13000 + Playwright; needs `npx playwright install chromium`
npm run e2e -- --no-build --no-ui  # API-only e2e, skips builds
npm run contracts:generate         # regenerate TS types from contracts/ and engine JSON Schemas from pydantic

cd engine && uv run pytest tests/test_policy.py::TestConstraints::test_moq_conflict_is_blocking   # one engine test
cd engine && uv run ruff check src tests && uv run ruff format src
cd apps/api && npx vitest run test/flow.spec.ts -t "approves idempotently"                        # one API test
cd engine && UPDATE_GOLDEN=1 uv run pytest tests/test_planner_integration.py                      # accept new golden quantities
```

Reset local state by stopping `npm run dev` and deleting `.data/`. DuckDB allows one writer: stop the engine before `npm run data`.

## Architecture

Three deployables share contracts in `contracts/`:

- `engine/` (Python 3.13, uv): stateless computation. `planner.plan()` takes a `PlanRequest`, reads history from the analytical store (`store.py`, DuckDB locally, BigQuery in production), forecasts each demand source (`forecast.py`, `analogue.py`), applies the (R, S) policy and item constraints with a trace (`policy.py`), then order-level constraints with CP-SAT (`optimiser.py`). `synthetic.py` generates the deterministic dataset whose planted edge cases the tests assert.
- `apps/api/` (NestJS 12, ESM, compiled with SWC for decorator metadata): modular monolith, one Postgres schema per module (`src/db/migrations.ts`). Modules write only their own schema; cross-module effects go through the transactional outbox (`messaging/`), dispatched in-process by `OutboxRelay` with an inbox for idempotency. `planning` freezes inputs, calls the engine, persists proposals; approval emits `order-proposal.approved`, which `purchasing` consumes to create the PO and submit it via the ERP port (`purchasing/erp/`). Every state change writes a hash-chained audit row in the same transaction.
- `apps/web/` (Next.js 16): client pages fetch through `/bff/...`, a route handler that attaches the token from an httpOnly cookie. Charts are hand-written SVG in `components/line-chart.tsx` following the dataviz palette in `globals.css`.

Contract discipline (tests enforce it):

- Engine schemas in `contracts/engine/` are generated from `engine/src/replen_engine/contracts.py`; `test_committed_schemas_match_models` fails on drift. The API validates every request and response against them.
- Events must validate against `contracts/events/*.schema.json` or `OutboxService.emit` throws. Adding an event means adding its schema and `index.json` entry, then `npm run contracts:generate`.
- API responses are validated against `contracts/openapi/replen-api.v1.yaml` in `apps/api/test/platform.spec.ts`; the web app compiles against the generated types.

Test data: API tests use `apps/api/test/fixtures/plan-response.json` (recorded engine output) and copies of the reference CSVs. After changing engine output or the generator, regenerate with `cd engine && uv run replen-engine plan --dir ../data/synthetic --db ../.data/analytics.duckdb --out ../apps/api/test/fixtures/plan-response.json`, and update `engine/tests/fixtures/expected_manifest.json` if the dataset itself changed.

## Conventions

- Every business figure is an assumption with an id in `docs/assumptions.md` (A-xx); cite it in code comments where a default comes from it.
- Engine JSON is camelCase via pydantic aliases; Python stays snake_case.
- API errors are problem details with a stable `code`; commands on proposals require `expectedVersion`; decision endpoints accept `Idempotency-Key`.
- TypeScript 7 (native) is used for API and contracts typechecking; the web app pins TypeScript 6.0.3 because `next build` needs the classic compiler API.
