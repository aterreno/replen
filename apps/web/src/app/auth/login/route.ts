import { API_URL, SESSION_COOKIE } from "@/lib/server";

/** Development sign-in: exchanges a user id for a dev token and stores it in an httpOnly cookie. */
export async function POST(req: Request) {
  const { userId } = (await req.json().catch(() => ({}))) as { userId?: string };
  if (!userId) return Response.json({ detail: "userId required" }, { status: 400 });
  const res = await fetch(`${API_URL}/api/v1/auth/dev-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  }).catch(() => null);
  if (!res) return Response.json({ detail: "replen-api is not reachable" }, { status: 502 });
  const body = (await res.json()) as { token?: string; expiresAt?: string; detail?: string };
  if (!res.ok || !body.token) return Response.json({ detail: body.detail ?? "sign-in failed" }, { status: res.status });
  const response = Response.json({ ok: true });
  const maxAge = Math.max(60, Math.floor((new Date(body.expiresAt ?? 0).getTime() - Date.now()) / 1000));
  response.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${body.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
  return response;
}
