/**
 * Load a legacy extract directory into a running replen-api through the import API, then optionally start
 * a planning run. Usage: node dist/cli/seed.js --dir ../../data/synthetic [--api http://127.0.0.1:4000] [--run]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadLegacyExtract } from "../imports/legacy-csv.js";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    api: { type: "string", default: process.env.API_URL ?? "http://127.0.0.1:4000" },
    admin: { type: "string", default: "admin.ada" },
    run: { type: "boolean", default: false },
  },
});

if (!values.dir) {
  console.error("--dir is required");
  process.exit(2);
}

async function call(path: string, body: unknown, token?: string) {
  const res = await fetch(`${values.api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const { token } = (await call("/api/v1/auth/dev-token", { userId: values.admin })) as { token: string };
for (const { entity, records } of loadLegacyExtract(resolve(values.dir))) {
  const r = (await call(`/api/v1/imports/${entity}`, { records }, token)) as { rows: number };
  console.log(JSON.stringify({ entity, rows: r.rows }));
}
if (values.run) {
  const run = (await call("/api/v1/planning-runs", {}, token)) as { runId: string; stats: unknown; accuracy: unknown };
  console.log(JSON.stringify({ planningRun: run.runId, stats: run.stats, accuracy: run.accuracy }));
}
