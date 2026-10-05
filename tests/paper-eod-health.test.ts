import { describe, expect, it, vi } from "vitest";
import { duePaperEodSession, paperEodDefects, checkPaperEodHealth } from "../lib/monitoring/paper-eod-health";

vi.mock("../lib/system-health", () => ({ reportIssue: vi.fn(), resolveIssue: vi.fn() }));

const valid = {
  date: "2026-09-25", snapshot_type: "eod", nav: 10_000,
  cash_balance: 2_000, positions_value: 8_000,
};

describe("canonical paper EOD monitoring", () => {
  it("waits for each market's close plus a bounded settlement grace", () => {
    expect(duePaperEodSession("india", new Date("2026-09-25T12:59:00Z"))).toBe("2026-09-24");
    expect(duePaperEodSession("india", new Date("2026-09-25T13:00:00Z"))).toBe("2026-09-25");
    expect(duePaperEodSession("us", new Date("2026-09-25T22:59:00Z"))).toBe("2026-09-24");
    expect(duePaperEodSession("us", new Date("2026-09-25T23:00:00Z"))).toBe("2026-09-25");
  });

  it("refuses absent or intraday rows and positive positions without marks", () => {
    expect(paperEodDefects(null, 0)).toContain("canonical paper_performance row is missing");
    expect(paperEodDefects({ ...valid, snapshot_type: "intraday" }, 1).join(" ")).toContain("not eod");
    expect(paperEodDefects(valid, 0).join(" ")).toContain("no persisted position mark");
    expect(paperEodDefects(valid, 1)).toEqual([]);
  });

  it("allows a fully invested or cash-only reconciled EOD, but not a bad NAV", () => {
    expect(paperEodDefects({ ...valid, cash_balance: 0, positions_value: 10_000 }, 1)).toEqual([]);
    expect(paperEodDefects({ ...valid, cash_balance: 10_000, positions_value: 0 }, 0)).toEqual([]);
    expect(paperEodDefects({ ...valid, nav: 10_100 }, 1).join(" ")).toContain("does not reconcile");
  });

  it("reports a persisted-row gap even when a monitor run could have completed", async () => {
    const { reportIssue, resolveIssue } = await import("../lib/system-health");
    const query = { eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
    const svc = { from: vi.fn((table: string) => table === "paper_performance"
      ? { select: () => query }
      : { select: () => ({ eq: vi.fn().mockReturnThis(), then: (resolve: any) => resolve({ count: 0, error: null }) }) }) };
    const defects = await checkPaperEodHealth(svc, "us", new Date("2026-09-25T23:30:00Z"));
    expect(defects).toContain("canonical paper_performance row is missing");
    expect(reportIssue).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "paper-eod-truth:us", severity: "critical" }), svc);
    expect(resolveIssue).not.toHaveBeenCalled();
  });
});
