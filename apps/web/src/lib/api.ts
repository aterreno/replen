import type { Problem } from "@replen/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.detail ?? `Request failed (${status})`);
  }

  /** Human-readable detail including field-level validation messages. */
  get messages(): string[] {
    const extra = (this.problem?.errors ?? [])
      .map((e) => e.message)
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    return extra.length ? extra : [this.message];
  }
}

/** All browser calls go through the BFF route, which attaches the httpOnly session token. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`/bff${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login";
    throw new ApiError(res.status, json);
  }
  return json as T;
}

export const fetcher = <T,>(path: string) => api<T>(path);

export const newIdempotencyKey = () => crypto.randomUUID();
