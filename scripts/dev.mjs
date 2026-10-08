// Local development stack without Docker: engine (DuckDB), mock ERP, API (file-backed PGlite), web (next dev).
// First start seeds the synthetic dataset and runs planning once. State persists in .data/; delete it to start over.
import { join } from "node:path";
import { ensureSyntheticData, http, importAnalytics, ROOT, run, start, waitFor } from "./lib/stack.mjs";
import { existsSync } from "node:fs";

const PORTS = { engine: 8000, erp: 4100, api: 4000, web: 3000 };
const dbPath = join(ROOT, ".data/analytics.duckdb");

ensureSyntheticData();
if (!existsSync(dbPath)) importAnalytics(dbPath);
run("npm", ["run", "build", "-w", "@replen/api"]);

start("engine", "uv", ["run", "replen-engine", "serve", "--port", String(PORTS.engine)], {
  cwd: join(ROOT, "engine"),
  env: { ENGINE_DUCKDB_PATH: dbPath },
});
start("erp", "node", ["apps/mock-erp/src/server.ts"], { env: { MOCK_ERP_PORT: String(PORTS.erp) } });
start("api", "node", ["--enable-source-maps", "apps/api/dist/main.js"], {
  env: {
    PORT: String(PORTS.api),
    PGLITE_DIR: join(ROOT, ".data/pglite"),
    ENGINE_URL: `http://127.0.0.1:${PORTS.engine}`,
    ERP_URL: `http://127.0.0.1:${PORTS.erp}`,
    EVENT_LOG_PATH: join(ROOT, ".data/events.ndjson"),
  },
});
await waitFor(`http://127.0.0.1:${PORTS.engine}/health`, "engine");
await waitFor(`http://127.0.0.1:${PORTS.erp}/health`, "mock ERP");
await waitFor(`http://127.0.0.1:${PORTS.api}/health`, "api");

const api = `http://127.0.0.1:${PORTS.api}`;
const products = await http(api, "/api/v1/products", {
  token: (await http(api, "/api/v1/auth/dev-token", { method: "POST", body: { userId: "admin.ada" } })).token,
});
if (products.length === 0) {
  console.log("empty database: importing synthetic extract and running planning");
  run("node", ["apps/api/dist/cli/seed.js", "--dir", "data/synthetic", "--api", api, "--run"]);
}

start("web", "npx", ["next", "dev", "-p", String(PORTS.web)], {
  cwd: join(ROOT, "apps/web"),
  env: { REPLEN_API_URL: api },
});
await waitFor(`http://127.0.0.1:${PORTS.web}/login`, "web", 120_000);
console.log(`\nReplen is running: http://localhost:${PORTS.web}  (API ${api}, engine :${PORTS.engine}, mock ERP :${PORTS.erp})\nCtrl-C to stop.\n`);
