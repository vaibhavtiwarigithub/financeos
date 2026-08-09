import { describe, expect, it } from "vitest";
import { compareCrossAsset, compareMortgagePrepayment } from "@/lib/capital-advisor/math";

describe("capital advisor deterministic safeguards", () => {
  const mortgage = { availableCash: 100_000, emergencyReserve: 20_000, nearTermObligations: 10_000, balance: 300_000, annualRatePct: 6, remainingMonths: 300, proposedPrincipal: 25_000, prepaymentPenalty: 0, interestDeductible: false, marginalTaxRatePct: 0 };
  it("never recommends principal payment below the stated liquidity floor", () => {
    const result = compareMortgagePrepayment({ ...mortgage, proposedPrincipal: 75_000 });
    expect(result.state).toBe("outside_policy");
    expect(result.liquidityAfter).toBeLessThan(result.liquidityFloor);
  });
  it("shows a positive partial prepayment as review-only, not an action", () => {
    const result = compareMortgagePrepayment(mortgage);
    expect(result.state).toBe("review_principal_payment");
    expect(result.netEstimatedBenefit).toBeGreaterThan(0);
    expect(result.monthsShortened).toBeGreaterThan(0);
  });
  it("does not rank a concentrated, illiquid property on a midpoint alone", () => {
    const result = compareCrossAsset({ availableCash: 100_000, emergencyReserve: 20_000, nearTermObligations: 10_000, investmentAmount: 50_000, holdingYears: 5, propertyRange: { lowerPct: -3, basePct: 18, upperPct: 35 }, marketRange: { lowerPct: 2, basePct: 8, upperPct: 14 }, propertyLiquidityRisk: "high", marketLiquidityRisk: "low", propertyConcentrationPct: 60, marketConcentrationPct: 20, evidenceQuality: "owner_assumption" });
    expect(result.state).toBe("indifferent_under_assumptions");
  });
  it("requires ordered return ranges", () => {
    expect(() => compareCrossAsset({ availableCash: 100_000, emergencyReserve: 1, nearTermObligations: 1, investmentAmount: 1, holdingYears: 1, propertyRange: { lowerPct: 5, basePct: 4, upperPct: 6 }, marketRange: { lowerPct: 1, basePct: 2, upperPct: 3 }, propertyLiquidityRisk: "low", marketLiquidityRisk: "low", propertyConcentrationPct: 0, marketConcentrationPct: 0, evidenceQuality: "verified" })).toThrow("return range must be ordered");
  });
});
