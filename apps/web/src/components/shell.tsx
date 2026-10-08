"use client";

import type { User } from "@replen/contracts";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext } from "react";
import { gbp0 } from "@/lib/format";
import { cx, SyntheticBadge } from "./ui";

const UserContext = createContext<User | null>(null);

export function useUser(): User {
  const u = useContext(UserContext);
  if (!u) throw new Error("useUser outside Shell");
  return u;
}

export const canPlan = (u: User) => u.roles.some((r) => ["planner", "senior_planner", "head_of_replenishment"].includes(r));

const NAV = [
  { href: "/proposals", label: "Work queue" },
  { href: "/purchase-orders", label: "Purchase orders" },
  { href: "/kpis", label: "KPIs" },
  { href: "/activity", label: "Events and audit" },
];

export function Shell({ user, children }: { user: User; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };
  return (
    <UserContext.Provider value={user}>
      <div className="flex min-h-screen">
        <aside className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-line bg-surface px-3 py-4">
          <Link href="/proposals" className="mb-6 px-2">
            <div className="text-base font-semibold tracking-tight">Replen</div>
            <div className="text-[11px] text-muted">Ordering and replenishment</div>
          </Link>
          <nav className="flex flex-col gap-0.5" aria-label="Main">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cx(
                  "rounded-md px-2 py-1.5 text-sm",
                  pathname.startsWith(n.href) ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-2",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="mt-auto space-y-2 px-2 text-xs">
            <SyntheticBadge />
            <div className="pt-2">
              <div className="font-medium text-ink" data-testid="current-user">
                {user.displayName}
              </div>
              <div className="text-muted">
                {user.roles.join(", ").replaceAll("_", " ")}
                {canPlan(user) && (
                  <> · limit {user.approvalLimit === null ? "unlimited" : gbp0(user.approvalLimit)}</>
                )}
              </div>
            </div>
            <button onClick={signOut} className="text-accent-ink hover:underline">
              Switch user
            </button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-6 py-5">{children}</main>
      </div>
    </UserContext.Provider>
  );
}
