import { describe, expect, it } from "vitest";
import { evaluateScoreExitShadow } from "./score-exit-shadow";

const point = (overrides: Partial<any> = {}) => ({
  date: "2026-01-01", symbol: "AAA", score: 35, entryThreshold: 60,
  forwardReturn: -0.1, benchmarkNeutralReturn: -0.08, mae: -0.02, mfe: 0.01,
  ...overrides,
});

describe("score exit shadow", () => {
  it("reports exit-to-cash improvement as the negative held return", () => {
    const result = evaluateScoreExitShadow({ market: "us", horizonDays: 10, points: [point()], stopPct: 0.07, targetPct: 0.08 });
    expect(result.arms[0].meanIncrementalVsHold).toBeCloseTo(0.1);
    expect(result.arms[0].avoidedLossShare).toBe(1);
  });

  it("refuses to attribute rows that touch a competing stop or target", () => {
    const result = evaluateScoreExitShadow({ market: "us", horizonDays: 10, points: [point({ mae: -0.08 })], stopPct: 0.07, targetPct: 0.08 });
    expect(result.arms[0].cleanTriggered).toBe(0);
    expect(result.arms[0].unresolvedMechanical).toBe(1);
    expect(result.arms[0].meanIncrementalVsHold).toBeNull();
  });

  it("deduplicates symbol/session and applies the overlap-adjusted floor", () => {
    const result = evaluateScoreExitShadow({ market: "india", horizonDays: 10, points: [point(), point({ forwardReturn: 0.2 })], stopPct: 0.07, targetPct: 0.08 });
    expect(result.observationCount).toBe(1);
    expect(result.effectiveObservations).toBe(0.1);
    expect(result.status).toBe("insufficient_evidence");
  });
});
