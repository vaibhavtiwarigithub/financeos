import { describe, expect, it } from "vitest";
import { evaluateForwardPairs, FORWARD_PROMOTION_WINDOWS, type ForwardPair } from "@/lib/validation/forward-shadow-selector";

function sessions(count: number): string[] {
  const out: string[] = [];
  const date = new Date("2025-01-01T12:00:00Z");
  while (out.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) out.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

function positivePairs(count = 40): ForwardPair[] {
  return sessions(count).map((session, i) => ({
    session, symbol: "AAA", candidateEnter: true, baselineEnter: false,
    benchmarkNeutralReturn: 0.02 + i * 0.0001,
  }));
}

describe("fixed forward shadow selector", () => {
  it("keeps immature cohorts insufficient instead of promoting", () => {
    const evidence = evaluateForwardPairs(positivePairs(38), 2);
    expect(evidence.status).toBe("insufficient_evidence");
    expect(evidence.effectiveWindows).toBeLessThan(FORWARD_PROMOTION_WINDOWS);
  });

  it("passes a positive matched challenger only after 20 non-overlapping windows", () => {
    const evidence = evaluateForwardPairs(positivePairs(), 2);
    expect(evidence.status).toBe("passed");
    expect(evidence.effectiveWindows).toBe(20);
    expect(evidence.pairedDifferenceCiLower95).toBeGreaterThan(0);
    expect(evidence.pairedDifferenceT).toBeGreaterThanOrEqual(2.093);
  });

  it("fails a challenger that loses to the same-session incumbent", () => {
    const pairs = positivePairs().map((row) => ({
      ...row, candidateEnter: false, baselineEnter: true,
    }));
    expect(evaluateForwardPairs(pairs, 2).status).toBe("failed");
  });

  it("freezes the first 20 windows so a later outlier cannot reverse the verdict", () => {
    const pairs = positivePairs();
    const later = sessions(41).slice(40).map((session) => ({
      session, symbol: "AAA", candidateEnter: true, baselineEnter: false,
      benchmarkNeutralReturn: 100,
    }));
    const first = evaluateForwardPairs(pairs, 2);
    const withLaterOutlier = evaluateForwardPairs([...pairs, ...later], 2);
    expect(withLaterOutlier.status).toBe(first.status);
    expect(withLaterOutlier.candidateMeanNetReturn).toBe(first.candidateMeanNetReturn);
    expect(withLaterOutlier.effectiveWindows).toBe(FORWARD_PROMOTION_WINDOWS);
  });

  it("deduplicates symbol/session rows using the earliest timestamp", () => {
    const rows = positivePairs().map((row) => ({ ...row, timestamp: `${row.session}T15:00:00Z` }));
    rows.push({ ...rows[0], timestamp: `${rows[0].session}T16:00:00Z`, candidateEnter: false, benchmarkNeutralReturn: -1 });
    const evidence = evaluateForwardPairs(rows, 2);
    expect(evidence.observations).toBe(41);
    expect(evidence.effectiveWindows).toBe(20);
    expect(evidence.candidateMeanNetReturn).toBeGreaterThan(0);
  });
});
