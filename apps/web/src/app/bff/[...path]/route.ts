import type { NextRequest } from "next/server";
import { API_URL, SESSION_COOKIE } from "@/lib/server";

/**
 * Backend-for-frontend proxy. The browser never sees the access token: it lives in an httpOnly cookie and is
 * attached here. Only the public API surface is reachable through this route.
 */
const FORWARD_REQUEST = ["content-type", "idempotency-key", "x-correlation-id"];
const FORWARD_RESPONSE = ["content-type", "x-correlation-id", "idempotency-replayed"];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = path.join("/");
  if (!target.startsWith("api/v1/") && target !== "health") {
    return Response.json({ title: "Not Found", status: 404, detail: "unknown route" }, { status: 404 });
  }
  const headers = new Headers();
  for (const h of FORWARD_REQUEST) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) headers.set("authorization", `Bearer ${token}`);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/${target}${req.nextUrl.search}`, { method: req.method, headers, body, cache: "no-store" });
  } catch {
    return Response.json(
      { title: "Bad Gateway", status: 502, code: "API_UNREACHABLE", detail: "replen-api is not reachable" },
      { status: 502 },
    );
  }
  const out = new Headers();
  for (const h of FORWARD_RESPONSE) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PATCH };
