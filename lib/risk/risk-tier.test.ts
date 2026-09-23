import { describe, it, expect } from "vitest";
import { computeRiskTier, type RiskTierInput } from "./risk-tier";

const BASE: RiskTierInput = {
  beta: null, atrMultipleMove: null, debtToEquity: null, profitMargin: null,
  grossMargin: null, isDiversifiedFund: false, macroDangerScore: null,
  daysToEarnings: null, breakdownVetoed: false,
  shortPercentFloat: null, daysToCoverShort: null,
};

describe("computeRiskTier", () => {
  it("floors at the base 30 (LOW) when zero components are available", () => {
    const r = computeRiskTier(BASE);
    expect(r.totalRisk).toBe(30);
    expect(r.tier).toBe("LOW");
    expect(r.coverage).toBe(0);
    expect(r.investability).toBe("full");
  });

  it("high beta and elevated ATR move raise volatility risk", () => {
    const r = computeRiskTier({ ...BASE, beta: 2.0, atrMultipleMove: 3 });
    expect(r.volatilityRisk).not.toBeNull();
    expect(r.totalRisk).toBeGreaterThan(30);
    expect(r.coverage).toBe(1);
  });

  it("negative margin + high debt/equity raise fragility risk", () => {
    const r = computeRiskTier({ ...BASE, debtToEquity: 3, profitMargin: -0.1, grossMargin: 0.05 });
    expect(r.fragilityRisk).toBe(30); // 15 + 15 + 5 capped at 30
  });

  it("a diversified fund gets a real near-zero concentration value, not unavailable", () => {
    const r = computeRiskTier({ ...BASE, isDiversifiedFund: true });
    expect(r.concentrationRisk).toBe(2);
    expect(r.coverage).toBe(1);
  });

  it("a single name has no concentration data source and stays unavailable", () => {
    const r = computeRiskTier({ ...BASE, isDiversifiedFund: false });
    expect(r.concentrationRisk).toBeNull();
  });

  it("macro risk scales linearly with danger_score and is excluded when null (India/stale)", () => {
    const red = computeRiskTier({ ...BASE, macroDangerScore: 100 });
    expect(red.macroRisk).toBe(15);
    const none = computeRiskTier({ ...BASE, macroDangerScore: null });
    expect(none.macroRisk).toBeNull();
  });

  it("earnings within 5 days and an active breakdown veto both add special risk, capped at 20", () => {
    const r = computeRiskTier({ ...BASE, daysToEarnings: 2, breakdownVetoed: true });
    expect(r.specialRisk).toBe(20);
  });

  it("earnings further than 5 days out does not add special risk", () => {
    const r = computeRiskTier({ ...BASE, daysToEarnings: 20 });
    expect(r.specialRisk).toBe(0);
  });

  it("heavy short interest with slow days-to-cover is the squeeze setup — higher risk than fast cover", () => {
    const slowCover = computeRiskTier({ ...BASE, shortPercentFloat: 0.25, daysToCoverShort: 8 });
    const fastCover = computeRiskTier({ ...BASE, shortPercentFloat: 0.25, daysToCoverShort: 1 });
    expect(slowCover.specialRisk).toBe(10);
    expect(fastCover.specialRisk).toBe(5);
    expect(slowCover.totalRisk).toBeGreaterThan(fastCover.totalRisk);
  });

  it("short interest below the 20% threshold adds no squeeze risk", () => {
    expect(computeRiskTier({ ...BASE, shortPercentFloat: 0.05, daysToCoverShort: 10 }).specialRisk).toBe(0);
  });

  it("tier boundaries match the disclosed thresholds", () => {
    expect(computeRiskTier(BASE).tier).toBe("LOW"); // 30
    expect(computeRiskTier({ ...BASE, macroDangerScore: 100 }).tier).toBe("MODERATE"); // 30 + macroRisk(15) = 45
    expect(computeRiskTier({ ...BASE, macroDangerScore: 100, daysToEarnings: 2 }).tier).toBe("HIGH"); // 30 + 15 + 15 = 60
  });

  it("investability tiers match the disclosed thresholds (>85 not_investable, 70-85 small, 50-69 medium, <50 full)", () => {
    expect(computeRiskTier(BASE).investability).toBe("full");
    const veryHigh = computeRiskTier({
      ...BASE, beta: 2.5, atrMultipleMove: 5, debtToEquity: 5, profitMargin: -0.5,
      grossMargin: 0.01, macroDangerScore: 100, daysToEarnings: 1, breakdownVetoed: true,
    });
    expect(veryHigh.totalRisk).toBe(100);
    expect(veryHigh.investability).toBe("not_investable");
    expect(veryHigh.tier).toBe("VERY_HIGH");
  });

  it("never exceeds 100 or drops below the 30 base", () => {
    const r = computeRiskTier({
      ...BASE, beta: 10, atrMultipleMove: 100, debtToEquity: 100, profitMargin: -100,
      grossMargin: -1, isDiversifiedFund: true, macroDangerScore: 1000, daysToEarnings: 0, breakdownVetoed: true,
    });
    expect(r.totalRisk).toBe(100);
  });
});
