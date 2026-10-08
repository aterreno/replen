"""HTTP interface for on-demand planning and what-if simulation."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import __version__
from .contracts import CONTRACT_VERSION, PlanRequest, PlanResponse
from .planner import plan
from .store import AnalyticsStore

logger = logging.getLogger("replen.engine")
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def _log(**fields) -> None:
    logger.info(json.dumps({"service": "replen-engine", **fields}, default=str))


def create_app(store: AnalyticsStore | None = None) -> FastAPI:
    store = store or AnalyticsStore(os.environ.get("ENGINE_DUCKDB_PATH", ".data/analytics.duckdb"))
    app = FastAPI(title="replen-engine", version=__version__)

    @app.middleware("http")
    async def correlation(request: Request, call_next):
        cid = request.headers.get("x-correlation-id") or str(uuid.uuid4())
        t = time.perf_counter()
        response = await call_next(request)
        response.headers["x-correlation-id"] = cid
        _log(
            msg="request",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            durationMs=round((time.perf_counter() - t) * 1000, 1),
            correlationId=cid,
        )
        return response

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "engineVersion": __version__,
            "contractVersion": CONTRACT_VERSION,
            "store": store.status(),
        }

    @app.post("/v1/plans", response_model=PlanResponse, response_model_by_alias=True)
    def create_plan(req: PlanRequest):
        if req.contract_version.split(".")[0] != CONTRACT_VERSION.split(".")[0]:
            raise HTTPException(
                status_code=422,
                detail=f"contract version {req.contract_version} not supported; engine speaks {CONTRACT_VERSION}",
            )
        if not req.items:
            raise HTTPException(status_code=422, detail="items must not be empty")
        with store.connect() as con:
            return plan(req, con)

    @app.exception_handler(FileNotFoundError)
    async def missing_store(_request: Request, exc: FileNotFoundError):
        return JSONResponse(status_code=503, content={"detail": f"analytics store not available: {exc}"})

    return app
