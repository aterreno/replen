import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { unprocessable } from "./errors.js";

/** JSON with object keys sorted recursively, so hashes do not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw unprocessable(
      "VALIDATION_FAILED",
      "Request failed validation",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

/** Locate a file relative to the repository root (contracts are read at runtime). */
export function repoPath(relative: string): string {
  if (process.env.REPLEN_REPO_ROOT) return resolve(process.env.REPLEN_REPO_ROOT, relative);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`cannot locate ${relative}; set REPLEN_REPO_ROOT`);
}

export const round2 = (x: number) => Math.round(x * 100) / 100;

/** Narrow a checked non-empty array to the tuple type JSON Schema `minItems: 1` generates. */
export function nonEmpty<T>(items: T[]): [T, ...T[]] {
  if (items.length === 0) throw new Error("expected a non-empty array");
  return items as [T, ...T[]];
}
