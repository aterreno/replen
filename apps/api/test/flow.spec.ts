/**
 * Vertical slice through the HTTP API: import -> plan -> review -> override -> approve -> PO -> ERP,
 * with events, audit and KPIs. Real Postgres semantics (PGlite), recorded engine output, in-memory ERP.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContractValidator } from "../src/messaging/contracts.js";
import type { Envelope } from "../src/messaging/outbox.service.js";
import { PurchasingService } from "../src/purchasing/purchasing.service.js";
import { auth, createTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let priya: string;
let omar: string;
let sam: string;
let viewer: string;
let admin: string;

const proposalFor = async (supplierId: string, status = "PROPOSED,AWAITING_APPROVAL") => {
  const res = await t.http.get(`/api/v1/order-proposals?status=${status}&supplierId=${supplierId}`).set(auth(priya)).expect(200);
  return res.body[0];
};
const detail = async (id: string, token = priya) => (await t.http.get(`/api/v1/order-proposals/${id}`).set(auth(token)).expect(200)).body;
const events = async () =>
  (await t.db.query<{ seq: number; envelope: Envelope }>("SELECT seq, envelope FROM messaging.outbox ORDER BY seq")).map((r) => r.envelope);

beforeAll(async () => {
  t = await createTestApp();
  [priya, omar, sam, viewer, admin] = await Promise.all(
    ["planner.priya", "planner.omar", "senior.sam", "viewer.vic", "admin.ada"].map((u) => t.token(u)),
  );
});
afterAll(() => t.close());

describe("import", () => {
  it("rejects imports from non-admins and invalid records", async () => {
    await t.http.post("/api/v1/imports/products").set(auth(priya)).send({ records: [] }).expect(403);
    const bad = await t.http
      .post("/api/v1/imports/products")
      .set(auth(admin))
      .send({ records: [{ sku: "X", name: "x", unitPrice: -1 }] })
      .expect(422);
    expect(bad.body.code).toBe("VALIDATION_FAILED");
    expect(bad.body.errors[0]).toHaveProperty("row", 0);
  });

  it("loads the synthetic legacy extract", async () => {
    await t.seed();
    const products = await t.http.get("/api/v1/products").set(auth(viewer)).expect(200);
    expect(products.body).toHaveLength(33);
    const pos = await t.http.get("/api/v1/inventory-positions?sku=HOM-BED-002&locationId=DC1").set(auth(viewer)).expect(200);
    expect(pos.body[0]).toMatchObject({ onHand: -6, availableToSell: 0 });
  });
});

describe("planning run", () => {
  it("builds a contract-valid engine request from transactional data", async () => {
    const res = await t.http.post("/api/v1/planning-runs").set(auth(priya)).send({}).expect(201);
    expect(res.body).toMatchObject({ status: "COMPLETED", asOfDate: "2026-10-05", requestedBy: "planner.priya" });
    expect(res.body.stats).toMatchObject({ items: 33, proposals: 6, lines: 33 });
    expect(res.body.accuracy.wape).toBeLessThan(res.body.accuracy.naiveWape);

    const req = t.engine.requests[0];
    expect(req.items).toHaveLength(33);
    const byKey = new Map(req.items.map((i) => [i.sku, i]));
    expect(byKey.get("HOM-BED-002")!.inventory.onHand).toBe(-6);
    expect(byKey.get("FUR-TBL-001")!.openOrders).toEqual([
      { reference: "LEG-PO-1005", quantity: 3, expectedDate: "2026-09-23" },
    ]);
    expect(byKey.get("FUR-SOF-001")!.policy.capacityUnits).toBe(6);
    expect(byKey.get("HOM-TWL-001")!.demandSources).toHaveLength(6);
    expect(req.orderConstraints).toEqual(
      expect.arrayContaining([
        { supplierId: "SUP-ELEC", destinationLocationId: "DC1", minOrderValue: 6000, budget: null },
        { supplierId: "SUP-FASH", destinationLocationId: "DC1", minOrderValue: 0, budget: 4500 },
      ]),
    );
    expect(new ContractValidator().validateEngine("plan-request", req).valid).toBe(true);
  });

  it("lists proposals exception-first", async () => {
    const res = await t.http.get("/api/v1/order-proposals").set(auth(priya)).expect(200);
    expect(res.body).toHaveLength(6);
    expect(res.body[0].unresolvedBlockingCount).toBeGreaterThan(0);
    expect(res.body[0].supplierId).toBe("SUP-HOME");
  });

  it("explains every line and blocks approval until blocking exceptions are decided", async () => {
    const p = await detail((await proposalFor("SUP-HOME")).proposalId);
    expect(p.approval.canApprove).toBe(false);
    expect(p.approval.reasons.map((r: { code: string }) => r.code)).toContain("BLOCKING_EXCEPTIONS");
    const vase = p.lines.find((l: { sku: string }) => l.sku === "HOM-VAS-001");
    expect(vase).toMatchObject({ severity: "blocking", recommendedQty: 24, moq: 24, resolved: false });
    expect(vase.exceptionCodes).toContain("MOQ_CONFLICT");
    expect(vase.explanation.steps.map((s: { key: string }) => s.key)).toContain("order_up_to");
    expect(vase.explanation.narrative).toMatch(/minimum order quantity/i);
    expect(vase.chart.history).toHaveLength(56);
    expect(p.lines[0].severity).toBe("blocking");

    const blocked = await t.http
      .post(`/api/v1/order-proposals/${p.proposalId}/approve`)
      .set(auth(priya))
      .send({ expectedVersion: p.version })
      .expect(409);
    expect(blocked.body.code).toBe("BLOCKING_EXCEPTIONS");
  });
});

describe("planner override", () => {
  it("validates pack multiples, MOQ, reason codes and versions", async () => {
    const p = await detail((await proposalFor("SUP-HOME")).proposalId);
    const vase = p.lines.find((l: { sku: string }) => l.sku === "HOM-VAS-001");
    const url = `/api/v1/order-proposals/${p.proposalId}/lines/${vase.lineId}`;
    const r1 = await t.http.patch(url).set(auth(priya)).send({ finalQty: 6, reasonCode: "MOQ_DECLINED", expectedVersion: 1 }).expect(422);
    expect(r1.body.errors.map((e: { code: string }) => e.code)).toContain("BELOW_MOQ");
    const r2 = await t.http.patch(url).set(auth(priya)).send({ finalQty: 25, reasonCode: "MOQ_DECLINED", expectedVersion: 1 }).expect(422);
    expect(r2.body.errors.map((e: { code: string }) => e.code)).toContain("PACK_MULTIPLE");
    await t.http.patch(url).set(auth(priya)).send({ finalQty: 0, reasonCode: "NOPE", expectedVersion: 1 }).expect(422);
    await t.http.patch(url).set(auth(viewer)).send({ finalQty: 0, reasonCode: "MOQ_DECLINED", expectedVersion: 1 }).expect(403);
    const stale = await t.http.patch(url).set(auth(priya)).send({ finalQty: 0, reasonCode: "MOQ_DECLINED", expectedVersion: 7 }).expect(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
  });

  it("records a reason-coded override that resolves the blocking line", async () => {
    const p = await detail((await proposalFor("SUP-HOME")).proposalId);
    const vase = p.lines.find((l: { sku: string }) => l.sku === "HOM-VAS-001");
    const res = await t.http
      .patch(`/api/v1/order-proposals/${p.proposalId}/lines/${vase.lineId}`)
      .set(auth(priya))
      .send({ finalQty: 0, reasonCode: "MOQ_DECLINED", note: "Slow mover, accept risk", expectedVersion: p.version })
      .expect(200);
    const line = res.body.lines.find((l: { sku: string }) => l.sku === "HOM-VAS-001");
    expect(line).toMatchObject({ finalQty: 0, recommendedQty: 24, overriddenBy: "planner.priya", resolved: true });
    expect(res.body.version).toBe(p.version + 1);
    expect(res.body.finalValue).toBeCloseTo(p.finalValue - 24 * 22, 2);
    expect(res.body.approval.canApprove).toBe(true);
  });
});

describe("approval and purchase order", () => {
  it("rejects approval by roles that cannot commit spend", async () => {
    const p = await proposalFor("SUP-HOME");
    const r = await t.http.post(`/api/v1/order-proposals/${p.proposalId}/approve`).set(auth(viewer)).send({ expectedVersion: p.version }).expect(403);
    expect(r.body.code).toBe("ROLE_REQUIRED");
    await t.http.post(`/api/v1/order-proposals/${p.proposalId}/approve`).set(auth(admin)).send({ expectedVersion: p.version }).expect(403);
  });

  it("approves idempotently", async () => {
    const p = await proposalFor("SUP-HOME");
    const url = `/api/v1/order-proposals/${p.proposalId}/approve`;
    const first = await t.http
      .post(url)
      .set({ ...auth(priya), "idempotency-key": "approve-home-1", "x-correlation-id": "corr-approve-home" })
      .send({ expectedVersion: p.version, comment: "ok" })
      .expect(200);
    expect(first.body).toMatchObject({ status: "APPROVED", decidedBy: "planner.priya" });
    const replay = await t.http
      .post(url)
      .set({ ...auth(priya), "idempotency-key": "approve-home-1" })
      .send({ expectedVersion: p.version, comment: "ok" })
      .expect(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    const reuse = await t.http
      .post(url)
      .set({ ...auth(priya), "idempotency-key": "approve-home-1" })
      .send({ expectedVersion: p.version, comment: "different" })
      .expect(422);
    expect(reuse.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const again = await t.http.post(url).set(auth(priya)).send({ expectedVersion: p.version + 1 }).expect(409);
    expect(again.body.code).toBe("NOT_OPEN");
  });

  it("creates the purchase order asynchronously and submits it to the ERP", async () => {
    await t.relay.drain();
    const home = await proposalFor("SUP-HOME", "APPROVED");
    const d = await detail(home.proposalId);
    expect(d.purchaseOrder).toMatchObject({ status: "SUBMITTED" });
    const po = (await t.http.get(`/api/v1/purchase-orders/${d.purchaseOrder.poId}`).set(auth(priya)).expect(200)).body;
    expect(po.lines.map((l: { sku: string }) => l.sku)).not.toContain("HOM-VAS-001");
    expect(po.lines).toHaveLength(d.orderedLineCount);
    expect(po.totalValue).toBeCloseTo(d.finalValue, 2);
    expect(po.erpPoNumber).toMatch(/^45/);
    const erpCopy = t.erp.orders.get(po.poId)!;
    expect(erpCopy.po.lines.reduce((s, l) => s + l.quantity, 0)).toBe(po.lines.reduce((s: number, l: { quantity: number }) => s + l.quantity, 0));

    const evs = await events();
    const approved = evs.find((e) => e.type === "replen.planning.order-proposal.approved.v1")!;
    const created = evs.find((e) => e.type === "replen.purchasing.purchase-order.created.v1")!;
    const submitted = evs.find((e) => e.type === "replen.purchasing.purchase-order.submitted.v1")!;
    expect(approved.correlationid).toBe("corr-approve-home");
    expect(created.correlationid).toBe("corr-approve-home");
    expect(created.causationid).toBe(approved.id);
    expect(submitted.subject).toBe(po.poId);
  });

  it("ignores duplicate delivery of the approval event", async () => {
    const approved = (await events()).find((e) => e.type === "replen.planning.order-proposal.approved.v1")!;
    const purchasing = t.app.get(PurchasingService);
    await purchasing.createFromApproval(approved as Envelope<"replen.planning.order-proposal.approved.v1">);
    await t.relay.drain();
    const pos = (await t.http.get("/api/v1/purchase-orders").set(auth(priya)).expect(200)).body;
    expect(pos).toHaveLength(1);
  });

  it("enforces approval limits and four-eyes escalation", async () => {
    const p = await proposalFor("SUP-ELEC");
    expect(p.finalValue).toBeGreaterThan(5000);
    const d = await detail(p.proposalId);
    expect(d.approval).toMatchObject({ canApprove: false, canEscalate: true, limit: 5000 });
    const url = `/api/v1/order-proposals/${p.proposalId}`;
    const over = await t.http.post(`${url}/approve`).set(auth(priya)).send({ expectedVersion: p.version }).expect(403);
    expect(over.body.code).toBe("APPROVAL_LIMIT_EXCEEDED");
    const esc = await t.http.post(`${url}/escalate`).set(auth(priya)).send({ expectedVersion: p.version, comment: "MOV top-up" }).expect(200);
    expect(esc.body).toMatchObject({ status: "AWAITING_APPROVAL", escalatedBy: "planner.priya" });
    const self = await t.http.post(`${url}/approve`).set(auth(priya)).send({ expectedVersion: esc.body.version }).expect(403);
    expect(self.body.code).toBe("FOUR_EYES");
    const peer = await t.http.post(`${url}/approve`).set(auth(omar)).send({ expectedVersion: esc.body.version }).expect(403);
    expect(peer.body.code).toBe("APPROVAL_LIMIT_EXCEEDED");
    const ok = await t.http.post(`${url}/approve`).set(auth(sam)).send({ expectedVersion: esc.body.version }).expect(200);
    expect(ok.body).toMatchObject({ status: "APPROVED", decidedBy: "senior.sam" });
  });

  it("records ERP failures and recovers on retry", async () => {
    t.erp.failNext(1);
    await t.relay.drain();
    const elec = await detail((await proposalFor("SUP-ELEC", "APPROVED")).proposalId);
    expect(elec.purchaseOrder.status).toBe("SUBMISSION_FAILED");
    const po = (await t.http.get(`/api/v1/purchase-orders/${elec.purchaseOrder.poId}`).set(auth(sam)).expect(200)).body;
    expect(po).toMatchObject({ submissionAttempts: 1, lastError: expect.stringContaining("503") });
    await t.http.post(`/api/v1/purchase-orders/${po.poId}/retry-submission`).set(auth(viewer)).expect(403);
    const retried = await t.http.post(`/api/v1/purchase-orders/${po.poId}/retry-submission`).set(auth(sam)).expect(200);
    expect(retried.body).toMatchObject({ status: "SUBMITTED", submissionAttempts: 2 });
    await t.http.post(`/api/v1/purchase-orders/${po.poId}/retry-submission`).set(auth(sam)).expect(409);
  });

  it("rejects with a reason", async () => {
    const p = await proposalFor("SUP-GARD");
    const url = `/api/v1/order-proposals/${p.proposalId}`;
    await t.http.post(`${url}/reject`).set(auth(priya)).send({ expectedVersion: p.version, reasonCode: "OTHER" }).expect(422);
    const r = await t.http.post(`${url}/reject`).set(auth(priya)).send({ expectedVersion: p.version, reasonCode: "NOT_REQUIRED" }).expect(200);
    expect(r.body.status).toBe("REJECTED");
    await t.http.post(`${url}/approve`).set(auth(priya)).send({ expectedVersion: r.body.version }).expect(409);
  });
});

describe("second run and what-if", () => {
  it("supersedes open proposals and counts Replen POs as on-order", async () => {
    const before = await proposalFor("SUP-FURN");
    await t.http.post("/api/v1/planning-runs").set(auth(priya)).send({}).expect(201);
    const old = await detail(before.proposalId);
    expect(old.status).toBe("SUPERSEDED");
    const homeApproved = await proposalFor("SUP-HOME", "APPROVED");
    expect(homeApproved.status).toBe("APPROVED");
    const req = t.engine.requests.at(-1)!;
    const towel = req.items.find((i) => i.sku === "HOM-TWL-001")!;
    expect(towel.openOrders!.some((o) => o.reference.startsWith("RPO-"))).toBe(true);
    const position = (await t.http.get("/api/v1/inventory-positions?sku=HOM-TWL-001&locationId=DC1").set(auth(priya)).expect(200)).body[0];
    expect(position.openOrders.map((o: { source: string }) => o.source).sort()).toEqual(["LEGACY", "REPLEN"]);
  });

  it("runs a what-if on frozen inputs without persisting", async () => {
    t.engine.transform = (res, req) => {
      expect(req.persist).toBe(false);
      expect(req.scenario).toMatchObject({ leadTimeDeltaDays: 7, demandMultiplier: 1.2 });
      res.items.forEach((i) => (i.recommendedQty = i.recommendedQty * 2));
      return res;
    };
    const p = await proposalFor("SUP-FURN");
    const r = await t.http
      .post(`/api/v1/order-proposals/${p.proposalId}/simulate`)
      .set(auth(priya))
      .send({ leadTimeDeltaDays: 7, demandMultiplier: 1.2 })
      .expect(200);
    t.engine.transform = undefined;
    expect(r.body.totals.scenarioUnits).toBe(2 * r.body.totals.baselineUnits);
    expect(r.body.lines.length).toBe(p.lineCount);
    const after = await detail(p.proposalId);
    expect(after.version).toBe(p.version);
  });
});

describe("events, audit and KPIs", () => {
  it("publishes only contract-valid events with per-aggregate ordering", async () => {
    await t.relay.drain();
    const validator = new ContractValidator();
    const evs = await events();
    expect(evs.length).toBeGreaterThan(20);
    const lastVersion = new Map<string, number>();
    for (const e of evs) {
      expect(validator.validateEvent(e)).toEqual({ valid: true, errors: [] });
      const prev = lastVersion.get(e.subject) ?? 0;
      expect(e.aggregateversion).toBeGreaterThan(prev);
      lastVersion.set(e.subject, e.aggregateversion);
    }
    const pending = await t.db.query("SELECT count(*)::int AS n FROM messaging.outbox WHERE published_at IS NULL");
    expect(pending[0].n).toBe(0);
    const types = new Set(evs.map((e) => e.type));
    // The flow exercises every event type in the catalogue.
    expect(types).toEqual(new Set(validator.eventTypes()));
  });

  it("keeps a verifiable audit trail of every decision", async () => {
    const verify = await t.http.get("/api/v1/audit-events/verify").set(auth(viewer)).expect(200);
    expect(verify.body).toMatchObject({ valid: true });
    expect(verify.body.checked).toBeGreaterThan(30);
    const home = await proposalFor("SUP-HOME", "APPROVED");
    const trail = (await t.http.get(`/api/v1/audit-events?entityType=order-proposal&entityId=${home.proposalId}`).set(auth(viewer)).expect(200)).body;
    expect(trail.map((a: { action: string }) => a.action)).toEqual([
      "order-proposal.approved",
      "order-proposal.line-adjusted",
      "order-proposal.created",
    ]);
    expect(trail[1]).toMatchObject({ actor: "planner.priya", before: { finalQty: 24 }, after: { finalQty: 0 } });
  });

  it("reports KPIs with definitions", async () => {
    const k = (await t.http.get("/api/v1/kpis").set(auth(viewer)).expect(200)).body;
    expect(k.synthetic).toBe(true);
    const all = Object.fromEntries(k.groups.flatMap((g: { kpis: { key: string }[] }) => g.kpis).map((x: { key: string }) => [x.key, x]));
    expect(all.wape.value).toBeGreaterThan(0);
    expect(all.forecast_value_added.value).toBeGreaterThan(0);
    expect(all.supplier_otif.value).toBeGreaterThan(0.5);
    expect(all.pos_submitted.value).toBe(2);
    expect(all.override_rate.value).toBeGreaterThan(0);
    expect(all.in_stock_rate.value).toBeGreaterThan(0);
    expect(all.stock_value.value).toBeGreaterThan(0);
    for (const kpi of Object.values(all) as { definition: string; source: string }[]) {
      expect(kpi.definition.length).toBeGreaterThan(10);
      expect(kpi.source.length).toBeGreaterThan(3);
    }
  });
});
