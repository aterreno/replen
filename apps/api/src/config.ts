import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),
  ENGINE_URL: z.string().default("http://127.0.0.1:8000"),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().default(120_000),
  ERP_URL: z.string().default("http://127.0.0.1:4100"),
  ERP_API_KEY: z.string().default("mock-erp-key"),
  AUTH_MODE: z.enum(["dev", "iap"]).default("dev"),
  AUTH_SECRET: z.string().min(16).default("dev-only-secret-change-me"),
  RELAY_INTERVAL_MS: z.coerce.number().int().min(0).default(500),
  EVENT_LOG_PATH: z.string().optional(),
  TENANT_ID: z.string().default("synthetic-retailer"),
  ERP_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  /** interval: background timer (long-running server). after-request: drain once each response is sent (serverless). */
  RELAY_MODE: z.enum(["interval", "after-request"]).default("interval"),
  /** http: ERP over HTTP through the ACL adapter. simulated: database-backed ERP simulator (hosted demo). */
  ERP_MODE: z.enum(["http", "simulated"]).default("http"),
  /** Hosted showcase: seed synthetic data on first use and allow admins to reset it. */
  DEMO_MODE: z.enum(["0", "1"]).default("0"),
});

export interface AppConfig {
  port: number;
  databaseUrl?: string;
  pgliteDir?: string;
  engineUrl: string;
  engineTimeoutMs: number;
  erpUrl: string;
  erpApiKey: string;
  authMode: "dev" | "iap";
  authSecret: string;
  relayIntervalMs: number;
  eventLogPath?: string;
  tenantId: string;
  erpMaxAttempts: number;
  relayMode: "interval" | "after-request";
  erpMode: "http" | "simulated";
  demoMode: boolean;
}

export const CONFIG = Symbol("CONFIG");

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const e = schema.parse(env);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,
    engineUrl: e.ENGINE_URL,
    engineTimeoutMs: e.ENGINE_TIMEOUT_MS,
    erpUrl: e.ERP_URL,
    erpApiKey: e.ERP_API_KEY,
    authMode: e.AUTH_MODE,
    authSecret: e.AUTH_SECRET,
    relayIntervalMs: e.RELAY_INTERVAL_MS,
    eventLogPath: e.EVENT_LOG_PATH,
    tenantId: e.TENANT_ID,
    erpMaxAttempts: e.ERP_MAX_ATTEMPTS,
    relayMode: e.RELAY_MODE,
    erpMode: e.ERP_MODE,
    demoMode: e.DEMO_MODE === "1",
  };
}
