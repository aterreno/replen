"""Command-line entry point: replen-engine <command>."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from .contracts import PlanRequest, PlanResponse


def _export_schemas(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, model in (("plan-request.v1.schema.json", PlanRequest), ("plan-response.v1.schema.json", PlanResponse)):
        schema = model.model_json_schema(by_alias=True, mode="validation" if model is PlanRequest else "serialization")
        (out / name).write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")
        print(f"wrote {out / name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="replen-engine")
    sub = parser.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="generate the deterministic synthetic dataset")
    g.add_argument("--out", required=True)
    g.add_argument("--seed", type=int, default=None)

    i = sub.add_parser("import", help="load sales history, promotions and product dimension into DuckDB")
    i.add_argument("--dir", required=True)
    i.add_argument("--db", default=os.environ.get("ENGINE_DUCKDB_PATH", ".data/analytics.duckdb"))

    e = sub.add_parser("export-schemas", help="write engine contract JSON Schemas")
    e.add_argument("--out", required=True)

    s = sub.add_parser("serve", help="run the HTTP API")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=int(os.environ.get("ENGINE_PORT", "8000")))

    pl = sub.add_parser("plan", help="plan the synthetic dataset from CSV files and write the response JSON")
    pl.add_argument("--dir", required=True)
    pl.add_argument("--db", default=os.environ.get("ENGINE_DUCKDB_PATH", ".data/analytics.duckdb"))
    pl.add_argument("--as-of", default="2026-10-05")
    pl.add_argument("--out", required=True)

    b = sub.add_parser("benchmark", help="measure forecast + policy throughput on generated series")
    b.add_argument("--series", type=int, default=2000)
    b.add_argument("--days", type=int, default=730)

    args = parser.parse_args(argv)

    if args.cmd == "generate":
        from .synthetic import DEFAULT_SEED, generate

        manifest = generate(args.out, args.seed if args.seed is not None else DEFAULT_SEED)
        print(json.dumps({"rows": manifest["rows"], "asOfDate": manifest["asOfDate"]}, indent=2))
        return 0
    if args.cmd == "import":
        from .store import AnalyticsStore

        t = time.perf_counter()
        counts = AnalyticsStore(args.db).import_dir(args.dir)
        print(json.dumps({"db": args.db, "counts": counts, "seconds": round(time.perf_counter() - t, 2)}))
        return 0
    if args.cmd == "export-schemas":
        _export_schemas(Path(args.out))
        return 0
    if args.cmd == "serve":
        import uvicorn

        from .api import create_app

        uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")
        return 0
    if args.cmd == "plan":
        from datetime import date

        from .dataset import build_plan_request
        from .planner import plan
        from .store import AnalyticsStore

        req = build_plan_request(args.dir, date.fromisoformat(args.as_of), run_id="fixture-run", persist=False)
        with AnalyticsStore(args.db).connect() as con:
            res = plan(req, con)
        Path(args.out).write_text(res.model_dump_json(by_alias=True, indent=1, exclude={"timings_ms"}) + "\n")
        print(json.dumps({"items": len(res.items), "orders": len(res.orders), "out": args.out}))
        return 0
    if args.cmd == "benchmark":
        from .benchmark import run_benchmark

        print(json.dumps(run_benchmark(args.series, args.days), indent=2))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
