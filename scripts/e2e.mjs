// End-to-end: fresh, isolated stack on separate ports with the real engine, mock ERP, API and web.
// 1. API: import the synthetic extract and run planning against the real engine.
// 2. Browser (Playwright): planner resolves a blocking line, approves, escalates, runs a what-if.
// 3. API: verify POs reached the mock ERP, every event was published, the audit chain verifies, KPIs reflect it.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSyntheticData, http, importAnalytics, ROOT, run, start, stopAll, waitFor } from "./lib/stack.mjs";

const PORTS = { engine: 18000, erp: 14100, api: 14000, web: 13000 };
const DIR = join(ROOT, ".data/e2e");
const skipBuild = process.argv.includes("--no-build");
const skipUi = process.argv.includes("--no-ui");
const api = `http://127.0.0.1:${PORTS.api}`;
const erp = `http://127.0.0.1:${PORTS.erp}`;
const timings = {};
const t0 = Date.now();
const mark = (k, since) => (timings[k] = Date.now() - since);

function check(cond, msg) {
  if (!cond) throw new Error(`E2E check failed: ${msg}`);
  console.log(`  ok  ${msg}`);
}

try {
  rmSync(DIR, { recursive: true, force: true });
  ensureSyntheticData();
  let s = Date.now();
  importAnalytics(join(DIR, "analytics.duckdb"));
  mark("analyticsImportMs", s);
  if (!skipBuild) {
    run("npm", ["run", "build", "-w", "@replen/api"]);
    if (!skipUi) run("npx", ["next", "build"], { cwd: join(ROOT, "apps/web") });
  }

  s = Date.now();
  start("engine", "uv", ["run", "replen-engine", "serve", "--port", String(PORTS.engine)], {
    cwd: join(ROOT, "engine"),
    env: { ENGINE_DUCKDB_PATH: join(DIR, "analytics.duckdb") },
    logDir: DIR,
  });
  start("erp", "node", ["apps/mock-erp/src/server.ts"], { env: { MOCK_ERP_PORT: String(PORTS.erp) }, logDir: DIR });
  start("api", "node", ["--enable-source-maps", "apps/api/dist/main.js"], {
    env: {
      PORT: String(PORTS.api),
      ENGINE_URL: `http://127.0.0.1:${PORTS.engine}`,
      ERP_URL: erp,
      RELAY_INTERVAL_MS: "200",
      EVENT_LOG_PATH: join(DIR, "events.ndjson"),
    },
    logDir: DIR,
  });
  if (!skipUi) {
    start("web", "npx", ["next", "start", "-p", String(PORTS.web)], {
      cwd: join(ROOT, "apps/web"),
      env: { REPLEN_API_URL: api },
      logDir: DIR,
    });
  }
  await Promise.all([
    waitFor(`http://127.0.0.1:${PORTS.engine}/health`, "engine"),
    waitFor(`${erp}/health`, "mock ERP"),
    waitFor(`${api}/health`, "api"),
    ...(skipUi ? [] : [waitFor(`http://127.0.0.1:${PORTS.web}/login`, "web")]),
  ]);
  mark("stackStartMs", s);

  console.log("\n1. Import and plan through the API");
  s = Date.now();
  run("node", ["apps/api/dist/cli/seed.js", "--dir", "data/synthetic", "--api", api]);
  mark("referenceImportMs", s);
  const token = async (u) => (await http(api, "/api/v1/auth/dev-token", { method: "POST", body: { userId: u } })).token;
  const priya = await token("planner.priya");
  s = Date.now();
  const runRes = await http(api, "/api/v1/planning-runs", { method: "POST", body: {}, token: priya });
  mark("planningRunMs", s);
  check(runRes.status === "COMPLETED", `planning run completed (${runRes.stats.items} items, ${runRes.stats.proposals} proposals)`);
  check(runRes.accuracy.wape < runRes.accuracy.naiveWape, `forecast beats seasonal naive (WAPE ${runRes.accuracy.wape} vs ${runRes.accuracy.naiveWape})`);
  const open = await http(api, "/api/v1/order-proposals?status=PROPOSED", { token: priya });
  check(open.length === 6, "six open proposals");

  if (!skipUi) {
    console.log("\n2. Planner workflow in the browser (Playwright)");
    s = Date.now();
    run("npx", ["playwright", "test"], { cwd: join(ROOT, "apps/web"), env: { ...process.env, E2E_WEB_URL: `http://127.0.0.1:${PORTS.web}` } });
    mark("browserFlowMs", s);
  } else {
    console.log("\n2. Planner workflow through the API (--no-ui)");
    const home = open.find((p) => p.supplierId === "SUP-HOME");
    const detail = await http(api, `/api/v1/order-proposals/${home.proposalId}`, { token: priya });
    const vase = detail.lines.find((l) => l.sku === "HOM-VAS-001");
    const adjusted = await http(api, `/api/v1/order-proposals/${home.proposalId}/lines/${vase.lineId}`, {
      method: "PATCH",
      token: priya,
      body: { finalQty: 0, reasonCode: "MOQ_DECLINED", expectedVersion: detail.version },
    });
    await http(api, `/api/v1/order-proposals/${home.proposalId}/approve`, {
      method: "POST",
      token: priya,
      body: { expectedVersion: adjusted.version },
      headers: { "idempotency-key": "e2e-home" },
    });
  }

  console.log("\n3. Verify downstream effects");
  let pos = [];
  for (let i = 0; i < 40; i++) {
    pos = await http(api, "/api/v1/purchase-orders", { token: priya });
    if (pos.length && pos.every((p) => p.status === "SUBMITTED")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check(pos.length >= 1 && pos.every((p) => p.status === "SUBMITTED"), `${pos.length} purchase order(s) submitted to the ERP`);
  const erpOrders = await http(erp, "/erp/v1/purchase-orders", { headers: { authorization: "Bearer mock-erp-key" } });
  for (const po of pos) {
    const copy = erpOrders.find((o) => o.CLIENT_REFERENCE === po.poId);
    check(copy && copy.ERP_PO_NUMBER === po.erpPoNumber, `${po.poNumber} present in mock ERP as ${copy?.ERP_PO_NUMBER}`);
    const qty = (lines, f) => lines.reduce((a, l) => a + f(l), 0);
    check(qty(copy.LINES, (l) => l.QTY) === qty(po.lines, (l) => l.quantity), `${po.poNumber} quantities match`);
  }
  const home = (await http(api, "/api/v1/order-proposals?status=APPROVED&supplierId=SUP-HOME", { token: priya }))[0];
  const homeDetail = await http(api, `/api/v1/order-proposals/${home.proposalId}`, { token: priya });
  check(homeDetail.lines.find((l) => l.sku === "HOM-VAS-001").finalQty === 0, "MOQ conflict resolved by the planner is reflected in the PO");
  const events = await http(api, "/api/v1/events?limit=500", { token: priya });
  check(events.every((e) => e.publishedAt), `all ${events.length} events published`);
  const approved = events.find((e) => e.event.type === "replen.planning.order-proposal.approved.v1" && e.event.subject === home.proposalId);
  const created = events.find((e) => e.event.type === "replen.purchasing.purchase-order.created.v1" && e.event.data.sourceProposalId === home.proposalId);
  const submitted = events.find((e) => e.event.type === "replen.purchasing.purchase-order.submitted.v1" && e.event.subject === created.event.subject);
  timings.approvalToErpMs = new Date(submitted.event.time) - new Date(approved.event.time);
  check(created.event.correlationid === approved.event.correlationid, "correlation id flows from approval to PO events");
  const verify = await http(api, "/api/v1/audit-events/verify", { token: priya });
  check(verify.valid, `audit hash chain verifies (${verify.checked} entries)`);
  const kpis = await http(api, "/api/v1/kpis", { token: priya });
  const k = Object.fromEntries(kpis.groups.flatMap((g) => g.kpis).map((x) => [x.key, x]));
  check(k.pos_submitted.value === pos.length, `KPI reports ${k.pos_submitted.value} submitted PO(s)`);

  timings.totalMs = Date.now() - t0;
  writeFileSync(join(DIR, "timings.json"), JSON.stringify(timings, null, 2));
  console.log("\nE2E passed", timings);
} catch (err) {
  console.error(`\nE2E FAILED: ${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ""}\nLogs: ${DIR}`);
  process.exitCode = 1;
} finally {
  stopAll();
}
