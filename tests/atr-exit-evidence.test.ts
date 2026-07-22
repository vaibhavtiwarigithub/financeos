import { describe, expect, it } from "vitest";
import {
  ATR_EXIT_POLICIES,
  ATR_EXIT_POLICY_VERSION,
  aggregateAtrExitEvidence,
  readEntryAtr,
  simulateAtrExitPolicy,
  type AtrExitOutcome,
} from "@/lib/learning/atr-exit-evidence";

const candle = (day: number, close: number) => ({
  date: `d${day}`,
  close,
  high: close + 20,
  low: close - 20,
});

describe("ATR exit evidence", () => {
  it("reads only a finite positive ATR from the frozen technical evidence", () => {
    expect(readEntryAtr({ technical: { atr14: 4.25 } })).toBe(4.25);
    expect(readEntryAtr({ technical: { atr14: 0 } })).toBeNull();
    expect(readEntryAtr({ technical: { atr14: "bad" } })).toBeNull();
    expect(readEntryAtr(null)).toBeNull();
  });

  it("uses closes, not intraday highs and lows, to trigger candidate exits", () => {
    const outcome = simulateAtrExitPolicy(100, 10, [candle(1, 101), candle(2, 102)], 2, ATR_EXIT_POLICIES[0]);
    expect(outcome?.exitReason).toBe("horizon");
    expect(outcome?.partialTriggered).toBe(false);
  });

  it("models one partial exit and a later close-observed trailing stop", () => {
    const policy = ATR_EXIT_POLICIES[0];
    const outcome = simulateAtrExitPolicy(100, 10, [
      candle(1, 116), // partial at the close; half remains
      candle(2, 120), // peak close, trailing stop becomes 115
      candle(3, 114), // remaining half exits at the close
    ], 3, policy);
    expect(outcome?.partialTriggered).toBe(true);
    expect(outcome?.exitReason).toBe("trailing_stop");
    expect(outcome?.exitDay).toBe(3);
    expect(outcome?.netReturn).toBeCloseTo(0.149, 6);
  });

  it("fails closed when the entry ATR or mature window is unavailable", () => {
    expect(simulateAtrExitPolicy(100, 0, [candle(1, 101)], 1, ATR_EXIT_POLICIES[0])).toBeNull();
    expect(simulateAtrExitPolicy(100, 10, [candle(1, 101)], 2, ATR_EXIT_POLICIES[0])).toBeNull();
  });

  it("keeps the evidence gate closed below both raw and effective sample floors", () => {
    const outcome = (policyId: string): AtrExitOutcome => ({
      policyId,
      policyVersion: ATR_EXIT_POLICY_VERSION,
      netReturn: 0.02,
      exitDay: 5,
      exitReason: "horizon",
      partialTriggered: false,
    });
    const makeRows = (count: number) => Array.from({ length: count }, () => ({
      horizonReturn: 0.01,
      outcomes: ATR_EXIT_POLICIES.map(policy => outcome(policy.id)),
    }));

    expect(aggregateAtrExitEvidence(makeRows(59), 2)[0].status).toBe("insufficient_sample");
    expect(aggregateAtrExitEvidence(makeRows(60), 10)[0].status).toBe("insufficient_sample");
    expect(aggregateAtrExitEvidence(makeRows(120), 10)[0].status).toBe("reviewable_evidence");
  });
});
