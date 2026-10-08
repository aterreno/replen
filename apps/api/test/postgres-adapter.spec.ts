/**
 * Exercises the node-postgres adapter (used with DATABASE_URL, i.e. Cloud SQL) over the Postgres wire
 * protocol. The server is PGlite behind pglite-socket, so no Docker is needed. It is single-session, so the
 * flow runs sequentially; concurrency behaviour of a real server is not covered here.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDb } from "../src/db/db.js";
import { auth, createTestApp, type TestApp } from "./helpers.js";

describe("node-postgres adapter over the wire protocol", () => {
  let server: PGLiteSocketServer;
  let t: TestApp;
  const port = 56000 + Math.floor(Math.random() * 1000);

  beforeAll(async () => {
    const pglite = await PGlite.create();
    server = new PGLiteSocketServer({ db: pglite, port, host: "127.0.0.1", maxConnections: 10 });
    await server.start();
    t = await createTestApp({ db: new PgDb(`postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`) });
  });
  afterAll(async () => {
    await t?.close();
    await server?.stop();
  });

  it("maps Postgres types consistently with PGlite", async () => {
    const [row] = await t.db.query(
      "SELECT 1.50::numeric AS n, 9007199254740::bigint AS b, DATE '2026-10-05' AS d, TIMESTAMPTZ '2026-10-05 10:00:00.5+00' AS ts",
    );
    expect(row).toEqual({ n: 1.5, b: 9007199254740, d: "2026-10-05", ts: "2026-10-05T10:00:00.500Z" });
  });

  it("runs import, planning, override, approval and PO submission", async () => {
    expect(t.db.kind).toBe("pg");
    await t.seed();
    const priya = await t.token("planner.priya");
    const me = await t.http.get("/api/v1/me").set(auth(priya)).expect(200);
    expect(me.body.approvalLimit).toBe(5000);
    await t.http.post("/api/v1/planning-runs").set(auth(priya)).send({}).expect(201);
    const [home] = (await t.http.get("/api/v1/order-proposals?supplierId=SUP-HOME").set(auth(priya)).expect(200)).body;
    const detail = (await t.http.get(`/api/v1/order-proposals/${home.proposalId}`).set(auth(priya)).expect(200)).body;
    const vase = detail.lines.find((l: { sku: string }) => l.sku === "HOM-VAS-001");
    const adjusted = await t.http
      .patch(`/api/v1/order-proposals/${home.proposalId}/lines/${vase.lineId}`)
      .set(auth(priya))
      .send({ finalQty: 0, reasonCode: "MOQ_DECLINED", expectedVersion: detail.version })
      .expect(200);
    await t.http
      .post(`/api/v1/order-proposals/${home.proposalId}/approve`)
      .set(auth(priya))
      .send({ expectedVersion: adjusted.body.version })
      .expect(200);
    await t.relay.drain();
    const pos = (await t.http.get("/api/v1/purchase-orders").set(auth(priya)).expect(200)).body;
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ status: "SUBMITTED", orderDate: "2026-10-05" });
    expect(typeof pos[0].totalValue).toBe("number");
    const verify = (await t.http.get("/api/v1/audit-events/verify").set(auth(priya)).expect(200)).body;
    expect(verify.valid).toBe(true);
  });
});
