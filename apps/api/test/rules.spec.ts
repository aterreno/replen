import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/imports/legacy-csv.js";
import type { AppUser } from "../src/identity/identity.js";
import { evaluateApproval, maxSeverity, validateAdjustment } from "../src/planning/rules.js";
import { canonicalJson } from "../src/common/util.js";
import { toIso } from "../src/db/db.js";

const planner: AppUser = { userId: "p", displayName: "P", roles: ["planner"], approvalLimit: 5000 };
const head: AppUser = { userId: "h", displayName: "H", roles: ["head_of_replenishment"], approvalLimit: null };
const viewer: AppUser = { userId: "v", displayName: "V", roles: ["viewer"], approvalLimit: 0 };
const open = { status: "PROPOSED", value: 1000, escalatedBy: null, unresolvedBlocking: 0, orderedLines: 3 };

describe("evaluateApproval", () => {
  it("allows a planner within limit", () => {
    expect(evaluateApproval(planner, open)).toMatchObject({ canApprove: true, canEscalate: false, reasons: [] });
  });

  it("blocks over-limit approval and offers escalation", () => {
    const r = evaluateApproval(planner, { ...open, value: 5000.01 });
    expect(r.canApprove).toBe(false);
    expect(r.canEscalate).toBe(true);
    expect(r.reasons.map((x) => x.code)).toEqual(["APPROVAL_LIMIT_EXCEEDED"]);
  });

  it("treats a null limit as unlimited", () => {
    expect(evaluateApproval(head, { ...open, value: 10_000_000 }).canApprove).toBe(true);
  });

  it("requires a different approver after escalation", () => {
    const r = evaluateApproval(head, { ...open, status: "AWAITING_APPROVAL", escalatedBy: "h" });
    expect(r.reasons.map((x) => x.code)).toEqual(["FOUR_EYES"]);
  });

  it("blocks unresolved blocking lines, empty orders, closed proposals and non-approver roles", () => {
    expect(evaluateApproval(planner, { ...open, unresolvedBlocking: 2 }).reasons[0].code).toBe("BLOCKING_EXCEPTIONS");
    expect(evaluateApproval(planner, { ...open, orderedLines: 0 }).reasons[0].code).toBe("NOTHING_TO_ORDER");
    expect(evaluateApproval(planner, { ...open, status: "APPROVED" }).reasons[0].code).toBe("NOT_OPEN");
    const v = evaluateApproval(viewer, open);
    expect(v.reasons.map((x) => x.code)).toEqual(["ROLE_REQUIRED"]);
    expect(v.canEscalate).toBe(false);
  });

  it("does not allow escalation while lines are blocking", () => {
    expect(evaluateApproval(planner, { ...open, value: 9000, unresolvedBlocking: 1 }).canEscalate).toBe(false);
  });
});

describe("validateAdjustment", () => {
  const line = { packSize: 6, moq: 12, recommendedQty: 24 };
  const codes = (fn: () => void) => {
    try {
      fn();
      return [];
    } catch (e) {
      return ((e as { details: { code?: string; field: string }[] }).details ?? []).map((d) => d.code ?? d.field);
    }
  };

  it("accepts valid overrides including zero below MOQ", () => {
    expect(codes(() => validateAdjustment(line, 0, "MOQ_DECLINED"))).toEqual([]);
    expect(codes(() => validateAdjustment(line, 36, "FORECAST_TOO_LOW"))).toEqual([]);
  });

  it("rejects non-pack multiples, below-MOQ and unknown reasons", () => {
    expect(codes(() => validateAdjustment(line, 7, "FORECAST_TOO_LOW"))).toContain("PACK_MULTIPLE");
    expect(codes(() => validateAdjustment(line, 6, "FORECAST_TOO_LOW"))).toContain("BELOW_MOQ");
    expect(codes(() => validateAdjustment(line, 12, "BOGUS"))).toContain("reasonCode");
  });

  it("requires a note for OTHER and for very large overrides", () => {
    expect(codes(() => validateAdjustment(line, 12, "OTHER"))).toContain("note");
    expect(codes(() => validateAdjustment(line, 96, "FORECAST_TOO_LOW"))).toContain("LARGE_OVERRIDE");
    expect(codes(() => validateAdjustment(line, 96, "FORECAST_TOO_LOW", "store opening"))).toEqual([]);
  });
});

describe("helpers", () => {
  it("ranks severities", () => {
    expect(maxSeverity(["info", "blocking", "warning"])).toBe("blocking");
    expect(maxSeverity([])).toBe("none");
  });

  it("parses quoted CSV", () => {
    const rows = parseCsv('a,b,c\n1,"x, y","say ""hi"""\r\n2,,\n');
    expect(rows).toEqual([
      { a: "1", b: "x, y", c: 'say "hi"' },
      { a: "2", b: "", c: "" },
    ]);
  });

  it("produces key-order independent canonical JSON", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { e: 1, f: 2 }] }, b: 1 }),
    );
  });

  it("normalises Postgres timestamps", () => {
    expect(toIso("2026-10-05 10:00:00+00")).toBe("2026-10-05T10:00:00.000Z");
    expect(toIso("2026-10-05 10:00:00.123456+00")).toBe("2026-10-05T10:00:00.123Z");
    expect(toIso("2026-10-05 11:00:00+01")).toBe("2026-10-05T10:00:00.000Z");
  });
});
