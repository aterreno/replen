import type { ButtonHTMLAttributes, ReactNode } from "react";
import { codeLabel } from "@/lib/format";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-ink text-page hover:opacity-90",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "border border-critical/40 bg-surface text-critical hover:bg-critical/5",
        className,
      )}
    />
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

const SEVERITY: Record<string, { label: string; dot: string; icon: string }> = {
  blocking: { label: "Needs decision", dot: "bg-critical", icon: "!" },
  warning: { label: "Warning", dot: "bg-warning", icon: "▲" },
  info: { label: "Info", dot: "bg-muted", icon: "i" },
  none: { label: "OK", dot: "bg-good", icon: "✓" },
};

/** Status colour always travels with an icon and a text label (never colour alone). */
export function SeverityBadge({ severity, compact }: { severity: string; compact?: boolean }) {
  const s = SEVERITY[severity] ?? SEVERITY.info;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2" title={s.label}>
      <span className={cx("inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white", s.dot)} aria-hidden>
        {s.icon}
      </span>
      {!compact && s.label}
    </span>
  );
}

export function ExceptionChip({ code, severity }: { code: string; severity?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-none whitespace-nowrap",
        severity === "blocking" ? "border-critical/50 text-ink" : "border-line text-ink-2",
      )}
    >
      {severity === "blocking" && <span className="h-1.5 w-1.5 rounded-full bg-critical" aria-hidden />}
      {severity === "warning" && <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />}
      {codeLabel(code)}
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  PROPOSED: "border-accent/40 text-accent-ink",
  AWAITING_APPROVAL: "border-warning/60 text-ink",
  APPROVED: "border-good/50 text-good-text",
  REJECTED: "border-line text-ink-2",
  SUPERSEDED: "border-line text-muted",
  CREATED: "border-line text-ink-2",
  SUBMITTED: "border-good/50 text-good-text",
  SUBMISSION_FAILED: "border-critical/50 text-critical",
  COMPLETED: "border-good/50 text-good-text",
  FAILED: "border-critical/50 text-critical",
  RUNNING: "border-accent/40 text-accent-ink",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cx("inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", STATUS_STYLE[status] ?? "border-line")}>
      {status.replaceAll("_", " ").toLowerCase()}
    </span>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-2">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "h-9 rounded-md border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none";

export function ErrorNote({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div role="alert" className="rounded-md border border-critical/40 bg-critical/5 px-3 py-2 text-sm text-ink">
      {messages.map((m) => (
        <div key={m}>{m}</div>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

export function SyntheticBadge() {
  return (
    <span className="rounded border border-warning/60 px-1.5 py-0.5 text-[11px] font-medium text-ink-2" title="All data in this environment is synthetic">
      Synthetic data
    </span>
  );
}
