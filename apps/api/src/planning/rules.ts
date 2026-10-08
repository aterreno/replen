import { unprocessable } from "../common/errors.js";
import { APPROVER_ROLES, type AppUser } from "../identity/identity.js";

/** Planning defaults from the assumption register. */
export const POLICY_DEFAULTS = {
  serviceLevel: 0.95, // A-40 fallback when an item-location has no target
  maxMoqCoverDays: 28, // A-43
  packRoundUpThreshold: 0.25, // A-44
  overdueGraceDays: 7, // A-42
};

export const OVERRIDE_REASONS: Record<string, string> = {
  ACCEPT_RECOMMENDATION: "Reviewed: accept recommendation",
  FORECAST_TOO_LOW: "Forecast too low (local knowledge)",
  FORECAST_TOO_HIGH: "Forecast too high",
  PROMO_NOT_IN_FORECAST: "Promotion or event not in forecast",
  MOQ_ACCEPTED: "Accept MOQ, excess stock acceptable",
  MOQ_DECLINED: "Decline MOQ, accept stockout risk",
  SUPPLIER_ISSUE: "Supplier allocation or availability",
  CAPACITY: "Space or capacity limit",
  BUDGET: "Budget or open-to-buy",
  DATA_QUALITY: "Stock or data error",
  OTHER: "Other (note required)",
};

export const REJECT_REASONS: Record<string, string> = {
  NOT_REQUIRED: "Not required this cycle",
  WRONG_DATA: "Input data wrong",
  SUPPLIER_UNAVAILABLE: "Supplier unavailable",
  BUDGET_FREEZE: "Budget freeze",
  OTHER: "Other (note required)",
};

export interface LineForRules {
  packSize: number;
  moq: number;
  recommendedQty: number;
}

export function validateAdjustment(line: LineForRules, finalQty: number, reasonCode: string, note?: string | null): void {
  const issues: Record<string, unknown>[] = [];
  if (!Number.isInteger(finalQty) || finalQty < 0) issues.push({ field: "finalQty", message: "must be a whole number >= 0" });
  if (finalQty % line.packSize !== 0) {
    const lower = Math.floor(finalQty / line.packSize) * line.packSize;
    issues.push({
      field: "finalQty",
      code: "PACK_MULTIPLE",
      message: `must be a multiple of the case pack ${line.packSize} (nearest: ${lower} or ${lower + line.packSize})`,
    });
  }
  if (finalQty > 0 && finalQty < line.moq) {
    issues.push({ field: "finalQty", code: "BELOW_MOQ", message: `must be 0 or at least the MOQ ${line.moq}` });
  }
  if (!(reasonCode in OVERRIDE_REASONS)) issues.push({ field: "reasonCode", message: `unknown reason ${reasonCode}` });
  if (reasonCode === "OTHER" && !note?.trim()) issues.push({ field: "note", message: "required when reason is OTHER" });
  const large = Math.max(3 * line.recommendedQty, line.recommendedQty + 10 * line.packSize);
  if (finalQty > large && !note?.trim()) {
    issues.push({ field: "note", code: "LARGE_OVERRIDE", message: `a note is required above ${large} units` });
  }
  if (issues.length) throw unprocessable("INVALID_ADJUSTMENT", "Line adjustment rejected", issues);
}

export interface ProposalForApproval {
  status: string;
  value: number;
  escalatedBy: string | null;
  unresolvedBlocking: number;
  orderedLines: number;
}

export interface ApprovalReason {
  code: string;
  message: string;
}

export interface ApprovalCheck {
  canApprove: boolean;
  canEscalate: boolean;
  value: number;
  limit: number | null;
  reasons: ApprovalReason[];
}

const gbp = (x: number) => `GBP ${x.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Approval controls. No financial commitment without a human approval within that human's limit (A-46);
 * the person who escalated cannot be the approver (four-eyes).
 */
export function evaluateApproval(user: AppUser, p: ProposalForApproval): ApprovalCheck {
  const reasons: ApprovalReason[] = [];
  const isApprover = APPROVER_ROLES.some((r) => user.roles.includes(r));
  const open = p.status === "PROPOSED" || p.status === "AWAITING_APPROVAL";
  if (!isApprover) reasons.push({ code: "ROLE_REQUIRED", message: "Your role cannot approve orders" });
  if (!open) reasons.push({ code: "NOT_OPEN", message: `Proposal is ${p.status}` });
  if (p.unresolvedBlocking > 0) {
    reasons.push({
      code: "BLOCKING_EXCEPTIONS",
      message: `${p.unresolvedBlocking} line(s) need a planner decision before approval`,
    });
  }
  if (p.orderedLines === 0) reasons.push({ code: "NOTHING_TO_ORDER", message: "All quantities are zero; reject instead" });
  if (p.status === "AWAITING_APPROVAL" && p.escalatedBy === user.userId) {
    reasons.push({ code: "FOUR_EYES", message: "You escalated this proposal; another approver must decide" });
  }
  const overLimit = user.approvalLimit !== null && p.value > user.approvalLimit;
  if (overLimit && isApprover) {
    reasons.push({
      code: "APPROVAL_LIMIT_EXCEEDED",
      message: `Order value ${gbp(p.value)} exceeds your approval limit ${gbp(user.approvalLimit ?? 0)}`,
    });
  }
  return {
    canApprove: reasons.length === 0,
    canEscalate:
      isApprover && overLimit && p.status === "PROPOSED" && p.unresolvedBlocking === 0 && p.orderedLines > 0,
    value: p.value,
    limit: user.approvalLimit,
    reasons,
  };
}

export const REASON_STATUS: Record<string, number> = {
  ROLE_REQUIRED: 403,
  APPROVAL_LIMIT_EXCEEDED: 403,
  FOUR_EYES: 403,
  NOT_OPEN: 409,
  BLOCKING_EXCEPTIONS: 409,
  NOTHING_TO_ORDER: 422,
};

export function maxSeverity(severities: string[]): "none" | "info" | "warning" | "blocking" {
  if (severities.includes("blocking")) return "blocking";
  if (severities.includes("warning")) return "warning";
  if (severities.includes("info")) return "info";
  return "none";
}
