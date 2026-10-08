import type { LoggerService } from "@nestjs/common";
import { currentContext } from "./context.js";

type Level = "debug" | "info" | "warn" | "error";

/** Structured JSON logs, one object per line, with the correlation id of the current request. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_LEVEL === "silent") return;
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: "replen-api",
    msg,
    correlationId: currentContext().correlationId,
    ...fields,
  });
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}

export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    log("info", String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string) {
    log("error", String(message), { context, trace });
  }
  warn(message: unknown, context?: string) {
    log("warn", String(message), { context });
  }
  debug(message: unknown, context?: string) {
    log("debug", String(message), { context });
  }
  verbose(message: unknown, context?: string) {
    log("debug", String(message), { context });
  }
}
