/**
 * Hosted-demo configuration (as deployed on Vercel): DEMO_MODE seeds on first use, the outbox drains after each
 * request instead of on a timer, and the ERP is the database-backed simulator.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoPath } from "../src/common/util.js";
import { CONTRACT_SCHEMAS } from "../src/generated/contract-schemas.js";
import { auth, createTestApp, type TestApp } from "./helpers.js";

const waitFor = async <T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("demo mode", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { DEMO_MODE: "1", ERP_MODE: "simulated", RELAY_MODE: "after-request" } });
  });
  afterAll(() => t.close());

  it("seeds and plans on the first API request", async () => {
    expect((await t.http.get("/api/v1/demo").expect(200)).body).toEqual({ demoMode: true, status: "empty" });
    const priya = await t.token("planner.priya");
    const proposals = (await t.http.get("/api/v1/order-proposals").set(auth(priya)).expect(200)).body;
    expect(proposals).toHaveLength(6);
    expect((await t.http.get("/api/v1/demo").expect(200)).body.status).toBe("ready");
    expect((await t.http.get("/health").expect(200)).body).toMatchObject({ demoMode: true, erpMode: "simulated" });
  });

  it("creates and submits the PO without a background timer", async () => {
    const priya = await t.token("planner.priya");
    const [home] = (await t.http.get("/api/v1/order-proposals?supplierId=SUP-HOME").set(auth(priya))).body;
    const detail = (await t.http.get(`/api/v1/order-proposals/${home.proposalId}`).set(auth(priya))).body;
    const vase = detail.lines.find((l: { sku: string }) => l.sku === "HOM-VAS-001");
    const adjusted = await t.http
      .patch(`/api/v1/order-proposals/${home.proposalId}/lines/${vase.lineId}`)
      .set(auth(priya))
      .send({ finalQty: 0, reasonCode: "MOQ_DECLINED", expectedVersion: detail.version })
      .expect(200);
    await t.http.post(`/api/v1/order-proposals/${home.proposalId}/approve`).set(auth(priya)).send({ expectedVersion: adjusted.body.version }).expect(200);
    const po = await waitFor(async () => {
      const pos = (await t.http.get("/api/v1/purchase-orders").set(auth(priya))).body;
      return pos[0]?.status === "SUBMITTED" ? pos[0] : undefined;
    });
    expect(po.erpPoNumber).toBe("4500100001");
    const [erp] = await t.db.query("SELECT payload FROM mock_erp.purchase_order WHERE client_reference = $1", [po.poId]);
    expect(erp.payload).toMatchObject({ VENDOR_NO: "SUP-HOME", ORDER_DATE: "20261005" });
    expect(erp.payload.LINES).toHaveLength(po.lines.length);
  });

  it("lets only admins reset, and reset restores the initial state", async () => {
    const priya = await t.token("planner.priya");
    const admin = await t.token("admin.ada");
    await t.http.post("/api/v1/demo/reset").set(auth(priya)).send({}).expect(403);
    const r = await t.http.post("/api/v1/demo/reset").set(auth(admin)).send({}).expect(200);
    expect(r.body.status).toBe("ready");
    const proposals = (await t.http.get("/api/v1/order-proposals").set(auth(priya)).expect(200)).body;
    expect(proposals.map((p: { status: string }) => p.status)).toEqual(Array(6).fill("PROPOSED"));
    expect((await t.http.get("/api/v1/purchase-orders").set(auth(priya))).body).toHaveLength(0);
    const verify = (await t.http.get("/api/v1/audit-events/verify").set(auth(priya))).body;
    expect(verify.valid).toBe(true);
    const runs = (await t.http.get("/api/v1/planning-runs").set(auth(priya))).body;
    expect(runs).toHaveLength(1);
  });
});

describe("embedded contract schemas", () => {
  it("match the files in contracts/ (run npm run contracts:generate after editing contracts)", () => {
    const dir = repoPath("contracts");
    const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
    const index = read("events/index.json") as { envelope: string; events: Record<string, string> };
    expect(CONTRACT_SCHEMAS.envelope).toEqual(read(`events/${index.envelope}`));
    for (const [type, file] of Object.entries(index.events)) {
      expect((CONTRACT_SCHEMAS.events as Record<string, unknown>)[type]).toEqual(read(`events/${file}`));
    }
    expect(CONTRACT_SCHEMAS.engine["plan-request"]).toEqual(read("engine/plan-request.v1.schema.json"));
    expect(CONTRACT_SCHEMAS.engine["plan-response"]).toEqual(read("engine/plan-response.v1.schema.json"));
  });
});
