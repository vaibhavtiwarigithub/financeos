import { describe, expect, it } from "vitest";
import {
  assessRotationP1Readiness,
  estimateRotationFrictionPct,
  measureCandidatePostSwapCorrelation,
  type RotationReturnRow,
} from "@/lib/trading/rotation-readiness";

function correlatedRows(): RotationReturnRow[] {
  const rows: RotationReturnRow[] = [];
  for (let i = 0; i < 65; i++) {
    const date = `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`;
    const value = ((i % 9) - 4) / 100;
    rows.push({ symbol: "NEW", session_date: date, simple_return: value, available_at: `2026-04-01T00:00:${String(i).padStart(2, "0")}Z` });
    rows.push({ symbol: "HELD", session_date: date, simple_return: value * 0.9, available_at: `2026-04-01T00:00:${String(i).padStart(2, "0")}Z` });
  }
  return rows;
}

describe("capital rotation P1 readiness", () => {
  it("measures candidate-to-post-swap correlation only with a sufficient aligned sample", () => {
    const result = measureCandidatePostSwapCorrelation(correlatedRows(), "NEW", ["HELD"], 60);
    expect(result.status).toBe("ok");
    expect(result.pairCount).toBe(1);
    expect(result.expectedPairCount).toBe(1);
    expect(result.maxCorrelationSymbol).toBe("HELD");
    expect(result.maxAbsCorrelation).toBeCloseTo(1, 8);
  });

  it("reports missing correlation instead of treating thin data as zero", () => {
    const result = measureCandidatePostSwapCorrelation(correlatedRows().slice(0, 20), "NEW", ["HELD"], 60);
    expect(result).toMatchObject({ status: "insufficient_data", maxAbsCorrelation: null, pairCount: 0, expectedPairCount: 1 });
  });

  it("uses the existing five-basis-point adverse fill model on each leg", () => {
    expect(estimateRotationFrictionPct(1_000, 1_000)).toBeCloseTo(0.05, 8);
  });

  it("fails closed on every unproven economic and portfolio input", () => {
    const result = assessRotationP1Readiness({
      persistencePriorRuns: 0,
      persistenceRequiredRuns: 1,
      turnoverBudgetMonthlyPct: null,
      monthlyTurnoverUsedPct: 12,
      proposedTurnoverPct: 20,
      taxSensitivity: "medium",
      hasExactTaxLots: false,
      expectedEdgePct: null,
      frictionPct: 0.05,
      postSwapAllowed: null,
      correlation: { status: "insufficient_data", maxAbsCorrelation: null, maxCorrelationSymbol: null, pairCount: 0, expectedPairCount: 1, minOverlap: 60 },
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "persistence_not_met",
      "turnover_budget_not_configured",
      "exact_tax_lots_unavailable",
      "score_to_return_mapping_unvalidated",
      "post_swap_gate_unavailable",
      "candidate_correlation_unavailable",
    ]));
  });

  it("can become ready only when all independent evidence gates pass", () => {
    const result = assessRotationP1Readiness({
      persistencePriorRuns: 2,
      persistenceRequiredRuns: 1,
      turnoverBudgetMonthlyPct: 50,
      monthlyTurnoverUsedPct: 10,
      proposedTurnoverPct: 15,
      taxSensitivity: "low",
      hasExactTaxLots: false,
      expectedEdgePct: 1.2,
      frictionPct: 0.1,
      postSwapAllowed: true,
      correlation: { status: "ok", maxAbsCorrelation: 0.4, maxCorrelationSymbol: "HELD", pairCount: 3, expectedPairCount: 3, minOverlap: 60 },
    });
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.netExpectedEdgePct).toBeCloseTo(1.1, 8);
    expect(result.turnoverAfterPct).toBe(25);
  });
});
