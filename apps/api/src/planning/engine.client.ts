import type { PlanRequest, PlanResponse } from "@replen/contracts";
import { currentContext } from "../common/context.js";
import { DomainError } from "../common/errors.js";

export interface DemoExtract {
  asOfDate: string;
  files: Record<string, string>;
}

export interface EngineClient {
  plan(request: PlanRequest): Promise<PlanResponse>;
  health(): Promise<"ok" | "unavailable">;
  /** Synthetic reference extract for demo seeding (engine regenerates it deterministically). */
  demoExtract(): Promise<DemoExtract>;
}

export const ENGINE = Symbol("ENGINE");

export class HttpEngineClient implements EngineClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async plan(request: PlanRequest): Promise<PlanResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/plans`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-correlation-id": currentContext().correlationId },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DomainError("ENGINE_UNAVAILABLE", 502, `engine unreachable: ${err instanceof Error ? err.message : err}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new DomainError("ENGINE_ERROR", 502, `engine returned ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as PlanResponse;
  }

  async demoExtract(): Promise<DemoExtract> {
    const res = await fetch(`${this.baseUrl}/v1/demo/extract`, {
      headers: { "x-correlation-id": currentContext().correlationId },
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err) => {
      throw new DomainError("ENGINE_UNAVAILABLE", 502, `engine unreachable: ${err instanceof Error ? err.message : err}`);
    });
    if (!res.ok) throw new DomainError("ENGINE_ERROR", 502, `engine demo extract returned ${res.status}`);
    return (await res.json()) as DemoExtract;
  }

  async health(): Promise<"ok" | "unavailable"> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? "ok" : "unavailable";
    } catch {
      return "unavailable";
    }
  }
}
