import type { User } from "@replen/contracts";
import { cookies } from "next/headers";

export const API_URL = process.env.REPLEN_API_URL ?? "http://127.0.0.1:4000";
export const SESSION_COOKIE = "replen_token";

/** Resolve the signed-in user from the httpOnly session cookie. Null when absent or rejected by the API. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_URL}/api/v1/me`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as User;
}
