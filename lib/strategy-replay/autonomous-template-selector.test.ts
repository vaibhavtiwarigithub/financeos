import { describe, expect, it } from "vitest";
import { evaluateAutonomousRuleForwardEvidence, type ForwardRuleOutcome } from "./autonomous-template-selector";

function fixture(n = 120, effect = 0.2, horizon = 5): ForwardRuleOutcome[] {
  return Array.from({ length: n }, (_, index) => {
    const session = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
    const entrySession = new Date(Date.UTC(2025, 0, 2 + index)).toISOString().slice(0, 10);
    const exitSession = new Date(Date.UTC(2025, 0, 2 + index + horizon)).toISOString().slice(0, 10);
    const baselineReturn = 0.1 + Math.sin(index * 1.73) * 0.05;
    return [
      { session, symbol: `A${index}`, wouldEnter: true, baselineEligible: true, entrySession, exitSession, netReturnPct: baselineReturn + effect },
      { session, symbol: `B${index}`, wouldEnter: false, baselineEligible: true, entrySession, exitSession, netReturnPct: baselineReturn },
    ];
  }).flat();
}

describe("autonomous template forward selector", () => {
  it("keeps small samples insufficient", () => {
    const result = evaluateAutonomousRuleForwardEvidence({ outcomes: fixture(30), horizonSessions: 5, trialCount: 1 });
    expect(result.status).toBe("insufficient");
    expect(result.pairedSessions).toBe(30);
    expect(result.nonoverlapWindows).toBe(6);
  });

  it("selects only a strong paired, net-positive, drawdown-safe forward edge", () => {
    const result = evaluateAutonomousRuleForwardEvidence({ outcomes: fixture(), horizonSessions: 5, trialCount: 4 });
    expect(result.status).toBe("select");
    expect(result.nonoverlapWindows).toBe(24);
    expect(result.meanPairedExcessPct).toBeGreaterThan(0);
    expect(result.oneSidedT).toBeGreaterThan(result.requiredT);
  });

  it("does not count overlapping horizon labels as independent windows", () => {
    const result = evaluateAutonomousRuleForwardEvidence({ outcomes: fixture(120, 0.2, 20), horizonSessions: 20, trialCount: 1 });
    expect(result.status).toBe("insufficient");
    expect(result.nonoverlapWindows).toBe(6);
    expect(result.reason).toContain("at least 400 sessions");
  });

  it("preserves an immature session slot instead of shifting later labels into it", () => {
    const rows = fixture(120);
    rows[10].netReturnPct = null;
    rows[10].entrySession = null;
    rows[10].exitSession = null;
    const result = evaluateAutonomousRuleForwardEvidence({ outcomes: rows, horizonSessions: 5, trialCount: 1 });
    expect(result.nonoverlapWindows).toBe(24);
    expect(result.status).toBe("select");
  });

  it("uses actual label entry/exit dates to reject overlapping samples", () => {
    const rows = fixture(120);
    for (const row of rows) { row.entrySession = "2025-01-02"; row.exitSession = "2025-01-12"; }
    const result = evaluateAutonomousRuleForwardEvidence({ outcomes: rows, horizonSessions: 5, trialCount: 1 });
    expect(result.status).toBe("insufficient");
    expect(result.nonoverlapWindows).toBe(1);
  });

  it("retires mature candidates without paired improvement", () => {
    const result = evaluateAutonomousRuleForwardEvidence({ outcomes: fixture(120, 0), horizonSessions: 5, trialCount: 4 });
    expect(result.status).toBe("retire");
  });

  it("fails closed on malformed and non-finite evidence", () => {
    const result = evaluateAutonomousRuleForwardEvidence({
      outcomes: [{ session: "not-a-date", symbol: "X", wouldEnter: true, baselineEligible: true, entrySession: null, exitSession: null, netReturnPct: Number.NaN }],
      horizonSessions: 5, trialCount: 1,
    });
    expect(result.status).toBe("insufficient");
  });

  it("raises the confidence bar as the declared trial family grows", () => {
    const small = evaluateAutonomousRuleForwardEvidence({ outcomes: fixture(100), horizonSessions: 5, trialCount: 1 });
    const large = evaluateAutonomousRuleForwardEvidence({ outcomes: fixture(100), horizonSessions: 5, trialCount: 100 });
    expect(small.requiredT).toBeCloseTo(1.729, 2);
    expect(large.requiredT).toBeGreaterThan(small.requiredT);
  });
});
