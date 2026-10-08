// Process helpers shared by dev.mjs and e2e.mjs: start the four services, wait for health, stop cleanly.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA = join(ROOT, "data/synthetic");

const children = [];

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
}

export function ensureSyntheticData() {
  if (!existsSync(join(DATA, "manifest.json"))) {
    console.log("generating synthetic dataset");
    run("uv", ["run", "replen-engine", "generate", "--out", DATA], { cwd: join(ROOT, "engine") });
  }
}

export function importAnalytics(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  run("uv", ["run", "replen-engine", "import", "--dir", DATA, "--db", dbPath], { cwd: join(ROOT, "engine") });
}

export function start(name, cmd, args, { cwd = ROOT, env = {}, logDir, inherit = false } = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (!inherit && logDir) {
    mkdirSync(logDir, { recursive: true });
    const log = createWriteStream(join(logDir, `${name}.log`));
    child.stdout.pipe(log);
    child.stderr.pipe(log);
  } else if (!inherit) {
    const prefix = (chunk) =>
      chunk
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((l) => `[${name}] ${l}`)
        .join("\n") + "\n";
    child.stdout.on("data", (c) => process.stdout.write(prefix(c)));
    child.stderr.on("data", (c) => process.stderr.write(prefix(c)));
  }
  child.on("exit", (code, signal) => {
    if (!stopping && (code || signal)) console.error(`${name} exited (${code ?? signal})`);
  });
  children.push({ name, child });
  return child;
}

let stopping = false;
export function stopAll() {
  stopping = true;
  for (const { child } of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

export async function waitFor(url, name, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${name} did not become healthy at ${url}`);
}

export async function http(base, path, { method = "GET", body, token, headers = {} } = {}, retried = false) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // A pooled keep-alive socket can be closed by the server while this process was blocked in spawnSync.
    if (!retried && err.cause?.code === "ECONNRESET") return http(base, path, { method, body, token, headers }, true);
    throw err;
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopAll();
    process.exit(130);
  });
}
