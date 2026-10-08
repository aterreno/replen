import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockErp, type MockErp } from "../../mock-erp/src/server.ts";
import { AuditService } from "../src/audit/audit.service.js";
import { repoPath } from "../src/common/util.js";
import { OutboxService } from "../src/messaging/outbox.service.js";
import { EventBus, OutboxRelay } from "../src/messaging/relay.service.js";
import { DomainError } from "../src/common/errors.js";
import { ErpError } from "../src/purchasing/erp/erp.port.js";
import { HttpErpAdapter } from "../src/purchasing/erp/http-erp.adapter.js";
import { auth, createTestApp, FixtureEngine, type TestApp } from "./helpers.js";

describe("audit log", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await t.seed();
  });
  afterAll(() => t.close());

  it("is append-only at the database level", async () => {
    await expect(t.db.query("UPDATE audit.audit_event SET actor = 'mallory'")).rejects.toThrow(/append-only/);
    await expect(t.db.query("DELETE FROM audit.audit_event")).rejects.toThrow(/append-only/);
  });

  it("detects tampering even if the trigger is bypassed", async () => {
    const audit = t.app.get(AuditService);
    expect((await audit.verify()).valid).toBe(true);
    await t.db.exec(`
      ALTER TABLE audit.audit_event DISABLE TRIGGER audit_event_append_only;
      UPDATE audit.audit_event SET metadata = '{"entity":"products","rows":1}'::jsonb WHERE seq = 3;
      ALTER TABLE audit.audit_event ENABLE TRIGGER audit_event_append_only;
    `);
    expect(await audit.verify()).toMatchObject({ valid: false, firstInvalidSeq: 3 });
  });
});

describe("outbox relay", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("keeps per-aggregate order when a handler fails and dead-letters after repeated failures", async () => {
    const outbox = t.app.get(OutboxService);
    const bus = t.app.get(EventBus);
    const relay = t.app.get(OutboxRelay);
    const seen: string[] = [];
    let failuresLeft = 2;
    bus.subscribe("replen.planning.order-proposal.superseded.v1", "test.consumer", async (e) => {
      if (e.subject === "00000000-0000-4000-8000-00000000000a" && failuresLeft-- > 0) throw new Error("transient");
      if (e.subject === "00000000-0000-4000-8000-00000000000c") throw new Error("poison");
      seen.push(`${e.subject.slice(-1)}${e.aggregateversion}`);
    });
    const runId = "00000000-0000-4000-8000-0000000000ff";
    await t.db.tx(async (q) => {
      for (const [subject, version] of [["a", 1], ["b", 1], ["a", 2], ["c", 1]] as const) {
        const id = `00000000-0000-4000-8000-00000000000${subject}`;
        await outbox.emit(q, "replen.planning.order-proposal.superseded.v1", id, version, { proposalId: id, supersededByRunId: runId });
      }
    });
    await relay.tick();
    expect(seen).toEqual(["b1"]); // a1 failed, so a2 must wait
    await relay.tick();
    expect(seen).toEqual(["b1"]);
    await relay.tick();
    expect(seen).toEqual(["b1", "a1", "a2"]);
    for (let i = 0; i < 10; i++) await relay.tick();
    const [dead] = await t.db.query("SELECT attempts, dead_lettered_at, last_error FROM messaging.outbox WHERE subject LIKE '%c'");
    expect(dead.attempts).toBe(10);
    expect(dead.dead_lettered_at).not.toBeNull();
    expect(dead.last_error).toBe("poison");
  });

  it("refuses to write events that violate their contract", async () => {
    const outbox = t.app.get(OutboxService);
    await expect(
      t.db.tx((q) =>
        outbox.emit(q, "replen.planning.order-proposal.superseded.v1", "x", 1, { proposalId: "not-a-uuid" } as never),
      ),
    ).rejects.toThrow(/violates its contract/);
  });
});

describe("engine failure", () => {
  it("marks the run FAILED, returns 502 and audits it", async () => {
    const engine = new FixtureEngine();
    engine.plan = async () => {
      throw new DomainError("ENGINE_UNAVAILABLE", 502, "engine unreachable: connection refused");
    };
    const t = await createTestApp({ engine });
    await t.seed();
    const tok = await t.token("planner.priya");
    const r = await t.http.post("/api/v1/planning-runs").set(auth(tok)).send({}).expect(502);
    expect(r.body).toMatchObject({ code: "ENGINE_UNAVAILABLE", status: 502 });
    expect(r.body.correlationId).toBeTruthy();
    const runs = (await t.http.get("/api/v1/planning-runs").set(auth(tok)).expect(200)).body;
    expect(runs[0]).toMatchObject({ status: "FAILED", error: expect.stringContaining("unreachable") });
    const trail = (await t.http.get(`/api/v1/audit-events?entityId=${runs[0].runId}`).set(auth(tok))).body;
    expect(trail.map((a: { action: string }) => a.action)).toContain("planning-run.failed");
    const proposals = (await t.http.get("/api/v1/order-proposals").set(auth(tok))).body;
    expect(proposals).toHaveLength(0);
    await t.close();
  });
});

describe("HTTP ERP adapter against the mock ERP", () => {
  let erp: MockErp;
  let adapter: HttpErpAdapter;
  const po = {
    poId: "11111111-1111-4111-8111-111111111111",
    poNumber: "RPO-100001",
    supplierId: "SUP-HOME",
    destinationLocationId: "DC1",
    orderDate: "2026-10-05",
    expectedDeliveryDate: "2026-10-19",
    currency: "GBP",
    lines: [
      { lineNo: 1, sku: "HOM-TWL-001", quantity: 24, unitCost: 7 },
      { lineNo: 2, sku: "HOM-TWL-002", quantity: 36, unitCost: 7 },
    ],
  };

  beforeAll(async () => {
    erp = createMockErp();
    adapter = new HttpErpAdapter(`http://127.0.0.1:${await erp.listen(0)}`, "mock-erp-key");
  });
  afterAll(() => erp.close());

  it("translates to the ERP format and is idempotent on PO id", async () => {
    const first = await adapter.submitPurchaseOrder(po);
    expect(first.duplicate).toBe(false);
    const stored = erp.orders.get(po.poId)!;
    expect(stored).toMatchObject({ VENDOR_NO: "SUP-HOME", ORDER_DATE: "20261005", DELIVERY_DATE: "20261019", EXT_REF: "RPO-100001" });
    expect(stored.LINES.map((l) => l.LINE_NO)).toEqual([10, 20]);
    const again = await adapter.submitPurchaseOrder(po);
    expect(again).toEqual({ erpPoNumber: first.erpPoNumber, duplicate: true });
  });

  it("maps 503 to retryable and 422 to non-retryable errors", async () => {
    erp.failNext(1);
    const transient = await adapter.submitPurchaseOrder({ ...po, poId: "22222222-2222-4222-8222-222222222222" }).catch((e) => e);
    expect(transient).toBeInstanceOf(ErpError);
    expect(transient.retryable).toBe(true);
    const rejected = await adapter
      .submitPurchaseOrder({ ...po, poId: "33333333-3333-4333-8333-333333333333", supplierId: "BLOCKED-1" })
      .catch((e) => e);
    expect(rejected.retryable).toBe(false);
    expect(rejected.message).toMatch(/blocked/);
  });

  it("treats an unreachable ERP as retryable", async () => {
    const down = new HttpErpAdapter("http://127.0.0.1:1", "k", 500);
    const err = await down.submitPurchaseOrder(po).catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(await down.health()).toBe("unavailable");
  });
});

describe("OpenAPI response contracts", () => {
  let t: TestApp;
  let validate: (schema: string, body: unknown) => string[];

  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const yaml = require("js-yaml") as { load(s: string): any };
    const Ajv2020 = require("ajv/dist/2020.js");
    const addFormats = require("ajv-formats");
    const spec = yaml.load(readFileSync(repoPath("contracts/openapi/replen-api.v1.yaml"), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: "openapi", components: spec.components });
    validate = (schema, body) => {
      const v = ajv.getSchema(`openapi#/components/schemas/${schema}`)!;
      return v(body) ? [] : (v.errors ?? []).map((e: { instancePath: string; message: string }) => `${e.instancePath} ${e.message}`);
    };
    t = await createTestApp();
    await t.seed();
    const tok = await t.token("planner.priya");
    await t.http.post("/api/v1/planning-runs").set(auth(tok)).send({}).expect(201);
  });
  afterAll(() => t.close());

  it("validator rejects documents that break the schema", () => {
    expect(validate("ProposalSummary", {}).length).toBeGreaterThan(0);
    expect(validate("User", { userId: "x", displayName: "x", roles: ["wizard"], approvalLimit: null })).not.toEqual([]);
  });

  it("matches the committed schemas", async () => {
    const tok = await t.token("planner.priya");
    const get = async (path: string) => (await t.http.get(path).set(auth(tok)).expect(200)).body;
    const proposals = await get("/api/v1/order-proposals");
    for (const p of proposals) expect(validate("ProposalSummary", p)).toEqual([]);
    expect(validate("Proposal", await get(`/api/v1/order-proposals/${proposals[0].proposalId}`))).toEqual([]);
    for (const r of await get("/api/v1/planning-runs")) expect(validate("PlanningRun", r)).toEqual([]);
    expect(validate("Kpis", await get("/api/v1/kpis"))).toEqual([]);
    for (const s of await get("/api/v1/suppliers")) expect(validate("Supplier", s)).toEqual([]);
    for (const p of await get("/api/v1/inventory-positions?locationId=DC1")) expect(validate("InventoryPosition", p)).toEqual([]);
    for (const a of await get("/api/v1/audit-events?limit=20")) expect(validate("AuditEvent", a)).toEqual([]);
    for (const e of await get("/api/v1/events?limit=20")) expect(validate("OutboxEvent", e)).toEqual([]);
    expect(validate("User", await get("/api/v1/me"))).toEqual([]);
    const problem = (await t.http.get("/api/v1/order-proposals/00000000-0000-4000-8000-000000000000").set(auth(tok)).expect(404)).body;
    expect(validate("Problem", problem)).toEqual([]);
  });
});
