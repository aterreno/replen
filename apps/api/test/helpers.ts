import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { PlanRequest, PlanResponse } from "@replen/contracts";
import request from "supertest";
import { AppModule, configureApp } from "../src/app.module.js";
import { loadConfig } from "../src/config.js";
import { DB, type Db, PgliteDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrations.js";
import { LEGACY_FILES, loadLegacyExtract } from "../src/imports/legacy-csv.js";
import { OutboxRelay } from "../src/messaging/relay.service.js";
import { ENGINE, type EngineClient } from "../src/planning/engine.client.js";
import { ERP, type ErpAcknowledgement, ErpError, type ErpPort, type ErpPurchaseOrder } from "../src/purchasing/erp/erp.port.js";

process.env.LOG_LEVEL = "silent";

export const FIXTURES = join(import.meta.dirname, "fixtures");

/** Replays a recorded engine response for the synthetic dataset, filtered to the requested items. */
export class FixtureEngine implements EngineClient {
  readonly requests: PlanRequest[] = [];
  private readonly fixture: PlanResponse = JSON.parse(readFileSync(join(FIXTURES, "plan-response.json"), "utf8"));
  transform?: (res: PlanResponse, req: PlanRequest) => PlanResponse;

  async plan(req: PlanRequest): Promise<PlanResponse> {
    this.requests.push(structuredClone(req));
    const wanted = new Set(req.items.map((i) => `${i.sku}|${i.destinationLocationId}`));
    const items = this.fixture.items.filter((i) => wanted.has(`${i.sku}|${i.destinationLocationId}`));
    const suppliers = new Set(items.map((i) => `${i.supplierId}|${i.destinationLocationId}`));
    const res: PlanResponse = {
      ...structuredClone(this.fixture),
      runId: req.runId,
      items: structuredClone(items),
      orders: structuredClone(this.fixture.orders.filter((o) => suppliers.has(`${o.supplierId}|${o.destinationLocationId}`))),
      timingsMs: {},
    };
    return this.transform ? this.transform(res, req) : res;
  }

  async health() {
    return "ok" as const;
  }

  async demoExtract() {
    const files = Object.fromEntries(
      LEGACY_FILES.map(({ file }) => [file, readFileSync(join(FIXTURES, "synthetic", file), "utf8")]),
    );
    return { asOfDate: "2026-10-05", files };
  }
}

/** In-memory ERP honouring the same idempotency contract as the mock ERP service. */
export class FakeErp implements ErpPort {
  readonly orders = new Map<string, { erpPoNumber: string; po: ErpPurchaseOrder }>();
  private failures: ErpError[] = [];
  private seq = 4500000000;

  failNext(count = 1, retryable = true) {
    for (let i = 0; i < count; i++) this.failures.push(new ErpError(retryable ? "ERP temporary failure: 503" : "ERP rejected order", retryable));
  }

  async submitPurchaseOrder(po: ErpPurchaseOrder): Promise<ErpAcknowledgement> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const existing = this.orders.get(po.poId);
    if (existing) return { erpPoNumber: existing.erpPoNumber, duplicate: true };
    const erpPoNumber = String(++this.seq);
    this.orders.set(po.poId, { erpPoNumber, po });
    return { erpPoNumber, duplicate: false };
  }

  async health() {
    return "ok" as const;
  }
}

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  db: Db;
  relay: OutboxRelay;
  engine: FixtureEngine;
  erp: FakeErp;
  token(userId: string): Promise<string>;
  seed(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: { engine?: FixtureEngine; erp?: FakeErp; db?: Db; env?: Record<string, string> } = {},
): Promise<TestApp> {
  const config = loadConfig({ AUTH_MODE: "dev", AUTH_SECRET: "test-secret-0123456789", RELAY_INTERVAL_MS: "0", ...opts.env });
  const db = opts.db ?? (await PgliteDb.create());
  await migrate(db);
  const engine = opts.engine ?? new FixtureEngine();
  const erp = opts.erp ?? new FakeErp();
  let builder = Test.createTestingModule({ imports: [AppModule.register(config)] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENGINE)
    .useValue(engine);
  // Simulated ERP mode exercises the real database-backed adapter instead of the in-memory fake.
  if (config.erpMode !== "simulated") builder = builder.overrideProvider(ERP).useValue(erp);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  const http = request(app.getHttpServer());
  const tokens = new Map<string, string>();
  const token = async (userId: string) => {
    if (!tokens.has(userId)) {
      const res = await http.post("/api/v1/auth/dev-token").send({ userId }).expect(200);
      tokens.set(userId, res.body.token);
    }
    return tokens.get(userId)!;
  };
  return {
    app,
    http,
    db,
    relay: app.get(OutboxRelay),
    engine,
    erp,
    token,
    async seed() {
      const admin = await token("admin.ada");
      for (const { entity, records } of loadLegacyExtract(join(FIXTURES, "synthetic"))) {
        await http.post(`/api/v1/imports/${entity}`).set("authorization", `Bearer ${admin}`).send({ records }).expect(200);
      }
    },
    async close() {
      await app.close();
    },
  };
}

export const auth = (t: string) => ({ authorization: `Bearer ${t}` });
