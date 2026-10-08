"use client";

import type { User } from "@replen/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { ErrorNote, SyntheticBadge } from "@/components/ui";
import { fetcher } from "@/lib/api";
import { gbp0 } from "@/lib/format";

export default function LoginPage() {
  const router = useRouter();
  const { data: users, error } = useSWR<User[]>("/api/v1/users", fetcher);
  const { data: demo } = useSWR<{ demoMode: boolean }>("/api/v1/demo", fetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const signIn = async (userId: string) => {
    setBusy(userId);
    setFailure(null);
    const res = await fetch("/auth/login", { method: "POST", body: JSON.stringify({ userId }) });
    if (!res.ok) {
      setFailure(((await res.json()) as { detail?: string }).detail ?? "Sign-in failed");
      setBusy(null);
      return;
    }
    router.push("/proposals");
    router.refresh();
  };

  return (
    <div className="mx-auto mt-24 w-full max-w-md px-4">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Replen</h1>
          <p className="text-sm text-ink-2">Development sign-in. Production uses the workforce identity provider.</p>
        </div>
        <SyntheticBadge />
      </div>
      {demo?.demoMode && (
        <p className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-2">
          Public demo with synthetic data. Pick any role to try the planner workflow; everyone shares the same data, which
          resets daily. Source and design documents:{" "}
          <a className="text-accent-ink hover:underline" href="https://github.com/aterreno/replen">github.com/aterreno/replen</a>.
        </p>
      )}
      {error && <ErrorNote messages={["The API is not reachable. Start it with npm run dev."]} />}
      {failure && <ErrorNote messages={[failure]} />}
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
        {(users ?? []).map((u) => (
          <li key={u.userId}>
            <button
              onClick={() => signIn(u.userId)}
              disabled={busy !== null}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface-2 disabled:opacity-60"
              data-testid={`login-${u.userId}`}
            >
              <span>
                <span className="block text-sm font-medium">{u.displayName}</span>
                <span className="block text-xs text-muted">{u.roles.join(", ").replaceAll("_", " ")}</span>
              </span>
              <span className="text-xs text-ink-2 tnum">
                {u.approvalLimit === null ? "unlimited" : u.approvalLimit > 0 ? `limit ${gbp0(u.approvalLimit)}` : "no approval"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
