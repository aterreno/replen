import { API_URL } from "@/lib/server";

/**
 * Daily demo reset, triggered by Vercel Cron (vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`.
 * Uses the development sign-in, which exists only while the API runs with AUTH_MODE=dev.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ detail: "unauthorized" }, { status: 401 });
  }
  const tokenRes = await fetch(`${API_URL}/api/v1/auth/dev-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "admin.ada" }),
  });
  if (!tokenRes.ok) return Response.json({ detail: "could not sign in as admin" }, { status: 502 });
  const { token } = (await tokenRes.json()) as { token: string };
  const reset = await fetch(`${API_URL}/api/v1/demo/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
  return new Response(await reset.text(), { status: reset.status, headers: { "content-type": "application/json" } });
}
