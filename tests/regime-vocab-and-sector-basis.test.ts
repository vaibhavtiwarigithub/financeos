import { describe, it, expect } from "vitest";
import { normalizeRegime } from "@/lib/allocation/allocator";
import { computeRiskMetrics } from "@/lib/portfolio-risk";

describe("normalizeRegime speaks MacroSentinel's vocabulary", () => {
  // MacroSentinel is the ONLY writer of macro_regime.regime and emits a danger
  // ladder (green|yellow|orange|red|unknown). This used to match only
  // risk_on/risk_off/bull/bear, so EVERY real prod label fell through to neutral
  // and the regime tilt was dead. Masked only by allocation_enabled=false.
  it("maps the danger ladder MacroSentinel actually writes", () => {
    expect(normalizeRegime("green")).toBe("risk_on");
    expect(normalizeRegime("yellow")).toBe("neutral");
    expect(normalizeRegime("orange")).toBe("risk_off");
    expect(normalizeRegime("red")).toBe("risk_off");
  });

  it("treats an absent verdict as neutral — never as calm", () => {
    // The fossil rule: no verdict is not a calm verdict.
    expect(normalizeRegime("unknown")).toBe("neutral");
    expect(normalizeRegime(null)).toBe("neutral");
    expect(normalizeRegime(undefined)).toBe("neutral");
    expect(normalizeRegime("")).toBe("neutral");
  });

  it("does not treat 'yellow' as de-risk", () => {
    // MacroSentinel calls yellow "Monitor closely". Mapping monitor -> risk_off
    // would bias the book bearish on the most common non-green state.
    expect(normalizeRegime("yellow")).not.toBe("risk_off");
  });

  it("still accepts legacy vocabularies (nothing emits them today)", () => {
    expect(normalizeRegime("risk_off")).toBe("risk_off");
    expect(normalizeRegime("bear market")).toBe("risk_off");
    expect(normalizeRegime("risk_on")).toBe("risk_on");
    expect(normalizeRegime("bullish")).toBe("risk_on");
  });
});

describe("sector weights use the denominator the cap is enforced on", () => {
  // $60k Tech + $40k Financials = $100k invested, inside a $200k NAV (50% cash).
  // The owner's sector cap is enforced on value/NAV (live-portfolio-gate.ts:68),
  // so an invested-relative bar reads 60% where the engine breached on 30%.
  const holdings = [
    { symbol: "AAPL", qty: 100, marketValue: 60_000, avgCost: 500, currentPrice: 600, unrealizedPnl: 10_000, unrealizedPnlPct: 20 },
    { symbol: "JPM", qty: 100, marketValue: 40_000, avgCost: 350, currentPrice: 400, unrealizedPnl: 5_000, unrealizedPnlPct: 14 },
  ] as any[];

  // NOTE: weightPct is a FRACTION (0-1) despite the "Pct" name — SP500_SECTOR_WEIGHTS
  // is 0.31 for Technology and the UI renders (weightPct * 100). Assert fractions.
  it("reports NAV-relative weights when NAV is supplied", async () => {
    const m = await computeRiskMetrics(holdings, undefined, { market: "us", navValue: 200_000 });
    const tech = m.sectorBreakdown.find((s) => s.sector === "Technology");
    expect(tech).toBeDefined();
    expect(tech!.basis).toBe("nav");
    expect(tech!.weightPct).toBeCloseTo(0.30, 4); // 60k / 200k — NOT 0.60
  });

  it("falls back to invested AND says so when NAV is absent", async () => {
    const m = await computeRiskMetrics(holdings, undefined, { market: "us" });
    const tech = m.sectorBreakdown.find((s) => s.sector === "Technology");
    expect(tech!.basis).toBe("invested");
    expect(tech!.weightPct).toBeCloseTo(0.60, 4); // 60k / 100k invested
  });

  it("weights sum to invested/NAV, not to 100, when cash is held", async () => {
    const m = await computeRiskMetrics(holdings, undefined, { market: "us", navValue: 200_000 });
    const total = m.sectorBreakdown.reduce((s, x) => s + x.weightPct, 0);
    expect(total).toBeCloseTo(0.50, 4); // 100k invested / 200k NAV — cash is real
  });

  it("overweight-vs-S&P stays INVESTED-relative even on the NAV basis", async () => {
    // The S&P is 100% invested. Comparing a cash-diluted weight to an index weight
    // would conflate asset allocation with sector selection: at 50% cash a NAV-basis
    // Tech weight reads "at benchmark" while you hold 2x the index's Tech among your
    // equities. Sector selection is a like-for-like question.
    const nav = await computeRiskMetrics(holdings, undefined, { market: "us", navValue: 200_000 });
    const inv = await computeRiskMetrics(holdings, undefined, { market: "us" });
    const techNav = nav.sectorBreakdown.find((s) => s.sector === "Technology")!;
    const techInv = inv.sectorBreakdown.find((s) => s.sector === "Technology")!;
    expect(techNav.weightPct).not.toBeCloseTo(techInv.weightPct, 4); // basis differs (0.30 vs 0.60)
    expect(techNav.overweightPct).toBeCloseTo(techInv.overweightPct, 5); // comparison does not
  });

  it("a bad NAV falls back to invested rather than dividing by it", async () => {
    for (const bad of [0, -1, NaN]) {
      const m = await computeRiskMetrics(holdings, undefined, { market: "us", navValue: bad });
      const tech = m.sectorBreakdown.find((s) => s.sector === "Technology")!;
      expect(tech.basis).toBe("invested");
      expect(Number.isFinite(tech.weightPct)).toBe(true);
    }
  });
});
