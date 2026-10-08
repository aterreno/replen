import json
from pathlib import Path

from fastapi.testclient import TestClient

from replen_engine.api import create_app
from replen_engine.contracts import PlanRequest, PlanResponse
from replen_engine.dataset import build_plan_request
from replen_engine.synthetic import generate

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts" / "engine"


def test_health(store):
    client = TestClient(create_app(store))
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["contractVersion"] == "1.0.0"
    assert body["store"]["salesRows"] > 100_000


def test_plan_endpoint_round_trip(store, synthetic_dir, as_of):
    client = TestClient(create_app(store))
    req = build_plan_request(synthetic_dir, as_of, persist=False)
    req.items = req.items[:3]
    r = client.post("/v1/plans", json=req.model_dump(mode="json", by_alias=True), headers={"x-correlation-id": "c1"})
    assert r.status_code == 200, r.text
    assert r.headers["x-correlation-id"] == "c1"
    body = r.json()
    assert "recommendedQty" in body["items"][0]
    PlanResponse.model_validate(body)


def test_rejects_unknown_major_version(store, synthetic_dir, as_of):
    client = TestClient(create_app(store))
    req = build_plan_request(synthetic_dir, as_of, persist=False)
    payload = req.model_dump(mode="json", by_alias=True)
    payload["contractVersion"] = "2.0.0"
    assert client.post("/v1/plans", json=payload).status_code == 422


def test_rejects_unknown_fields(store, synthetic_dir, as_of):
    client = TestClient(create_app(store))
    payload = build_plan_request(synthetic_dir, as_of, persist=False).model_dump(mode="json", by_alias=True)
    payload["items"][0]["surprise"] = 1
    assert client.post("/v1/plans", json=payload).status_code == 422


def test_committed_schemas_match_models():
    """Contract drift guard: regenerate with `replen-engine export-schemas --out ../contracts/engine`."""
    req = json.loads((CONTRACTS / "plan-request.v1.schema.json").read_text())
    res = json.loads((CONTRACTS / "plan-response.v1.schema.json").read_text())
    assert req == json.loads(json.dumps(PlanRequest.model_json_schema(by_alias=True, mode="validation")))
    assert res == json.loads(json.dumps(PlanResponse.model_json_schema(by_alias=True, mode="serialization")))


def test_generator_is_deterministic(tmp_path):
    expected = json.loads((Path(__file__).parent / "fixtures" / "expected_manifest.json").read_text())
    m1 = generate(tmp_path / "a")
    m2 = generate(tmp_path / "b")
    assert m1["files"] == m2["files"]
    assert m1["files"] == expected["files"], "synthetic data changed: regenerate fixtures deliberately"


def test_serverless_bootstrap_generates_and_serves_extract(tmp_path, monkeypatch):
    monkeypatch.setenv("ENGINE_BOOTSTRAP", "1")
    monkeypatch.setenv("ENGINE_SYNTHETIC_DIR", str(tmp_path / "synthetic"))
    from replen_engine.store import AnalyticsStore

    store = AnalyticsStore(tmp_path / "boot.duckdb")
    client = TestClient(create_app(store))
    r = client.get("/v1/demo/extract")
    assert r.status_code == 200
    body = r.json()
    assert body["asOfDate"] == "2026-10-05"
    assert body["files"]["products.csv"].startswith("sku,name,category")
    assert "sales_history.csv" not in body["files"]
    assert store.status()["salesRows"] > 100_000
