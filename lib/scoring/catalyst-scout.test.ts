import { describe, it, expect } from "vitest";
import { computeCatalystScout, type CatalystInput } from "./catalyst-scout";

const BASE: CatalystInput = {
  daysToEarnings: null, analystConsensusScore: null, insiderScore: null,
  insiderAvailable: false, capitalFlow5d: null, breakdownVetoed: false,
};

describe("computeCatalystScout", () => {
  it("sits at the neutral base 50 when zero evidence is available", () => {
    const r = computeCatalystScout(BASE);
    expect(r.totalScore).toBe(50);
    expect(r.coverage).toBe(0);
    expect(r.classification).toBe("neutral");
  });

  it("earnings known but far out contributes zero setup, not null", () => {
    const r = computeCatalystScout({ ...BASE, daysToEarnings: 30 });
    expect(r.earningsSetup).toBe(0);
    expect(r.coverage).toBe(1);
  });

  it("imminent earnings + bullish analyst consensus is a positive setup", () => {
    const r = computeCatalystScout({ ...BASE, daysToEarnings: 3, analystConsensusScore: 90 });
    expect(r.earningsSetup).toBeGreaterThan(0);
    expect(r.expectationAsymmetry).toBeGreaterThan(0);
  });

  it("imminent earnings + bearish consensus is a negative setup", () => {
    const r = computeCatalystScout({ ...BASE, daysToEarnings: 3, analystConsensusScore: 10 });
    expect(r.earningsSetup).toBeLessThan(0);
  });

  it("earnings within the 5-day risk window always penalizes, regardless of setup direction", () => {
    const bullish = computeCatalystScout({ ...BASE, daysToEarnings: 2, analystConsensusScore: 90 });
    expect(bullish.eventRiskPenalty).toBeLessThanOrEqual(-15);
  });

  it("an active breakdown veto adds its own penalty independent of earnings", () => {
    const r = computeCatalystScout({ ...BASE, breakdownVetoed: true });
    expect(r.eventRiskPenalty).toBe(-10);
  });

  it("both risk flags together classify as high_risk_binary_event regardless of score", () => {
    const r = computeCatalystScout({ ...BASE, daysToEarnings: 1, analystConsensusScore: 95, breakdownVetoed: true });
    expect(r.eventRiskPenalty).toBe(-25);
    expect(r.classification).toBe("high_risk_binary_event");
  });

  it("insider signal is excluded (null) unless the insider dimension was actually available", () => {
    const unavailable = computeCatalystScout({ ...BASE, insiderScore: 90, insiderAvailable: false });
    expect(unavailable.insiderSignal).toBeNull();
    const available = computeCatalystScout({ ...BASE, insiderScore: 90, insiderAvailable: true });
    expect(available.insiderSignal).toBeGreaterThan(0);
  });

  it("capital flow sign determines the non-earnings catalyst direction", () => {
    expect(computeCatalystScout({ ...BASE, capitalFlow5d: 5_000_000 }).nonEarningsCatalyst).toBe(8);
    expect(computeCatalystScout({ ...BASE, capitalFlow5d: -5_000_000 }).nonEarningsCatalyst).toBe(-6);
    expect(computeCatalystScout({ ...BASE, capitalFlow5d: 0 }).nonEarningsCatalyst).toBe(0);
  });

  it("never exceeds 0-100", () => {
    const max = computeCatalystScout({
      daysToEarnings: 20, analystConsensusScore: 100, insiderScore: 100, insiderAvailable: true,
      capitalFlow5d: 1, breakdownVetoed: false,
    });
    expect(max.totalScore).toBeLessThanOrEqual(100);
    const min = computeCatalystScout({
      daysToEarnings: 1, analystConsensusScore: 0, insiderScore: 0, insiderAvailable: true,
      capitalFlow5d: -1, breakdownVetoed: true,
    });
    expect(min.totalScore).toBeGreaterThanOrEqual(0);
  });
});
