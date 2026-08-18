import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { computeWeightedAnalystScore } from "@/lib/scoring/weighted-score";

/**
 * ETF fundamental is INAPPLICABLE — and nothing was checking it.
 *
 * `scoreFundamentals` returns a flat 55 for any ETF ("no company fundamentals;
 * neutral 55 baseline") and `dataQuality.fundamentalDataAvailable` is
 * `isEtf || hasMinFundamentalFields(...)` — i.e. TRUE for every ETF. The only
 * thing stopping that constant entering the weighted score at 30% base weight is
 * a single `!isEtf &&` in lib/research-agent.ts.
 *
 * Production confirms the guard works today: SGOV/GLD/XAR carry
 * availability_mask.fundamental=false, included_dims [technical, sentiment,
 * macro], and applied fundamental weight 0 — matching v_decision_quality's ETF
 * applicable list exactly. So this is NOT a bug report. It is the missing
 * detector: no test covered the invariant, so deleting that guard would silently
 * feed a fabricated constant into every ETF score against a 60 entry threshold.
 */
describe("ETF fundamental is inapplicable, not merely available", () => {
  const weights = { fundamental: 0.30, technical: 0.25, sentiment: 0.20, macro: 0.15, insider: 0.10 };
  // A deliberately lopsided case: the constant 55 differs sharply from the real
  // dimensions, so including it moves the score by a visible margin.
  const scores = { fundamental: 55, technical: 90, sentiment: 80, macro: 70, insider: 50 };

  it("renormalises across the applicable dimensions only", () => {
    const etf = computeWeightedAnalystScore(
      scores,
      { fundamental: false, technical: true, sentiment: true, macro: true, insider: false },
      weights,
    );
    expect(etf.includedDims.sort()).toEqual(["macro", "sentiment", "technical"]);
    expect(etf.renormalized).toBe(true);
    // 0.25/0.60*90 + 0.20/0.60*80 + 0.15/0.60*70 = 81.67, returned rounded.
    expect(etf.score).toBe(82);
    expect(etf.effWeights.fundamental).toBe(0);
  });

  it("including the 55 would MOVE the score — so the guard is load-bearing", () => {
    const withConstant = computeWeightedAnalystScore(
      scores,
      { fundamental: true, technical: true, sentiment: true, macro: true, insider: false },
      weights,
    );
    const withoutConstant = computeWeightedAnalystScore(
      scores,
      { fundamental: false, technical: true, sentiment: true, macro: true, insider: false },
      weights,
    );
    // ~72.2 vs ~81.7 — nearly 10 points, either side of a 60/75 threshold in
    // other configurations. This is why the invariant needs a detector.
    expect(Math.abs(withConstant.score - withoutConstant.score)).toBeGreaterThan(5);
  });

  it("the live path gates fundamental on !isEtf — the one line holding the invariant", () => {
    // Route-shaped on purpose: the guard lives in the caller, not in the pure
    // function, so no unit test of computeWeightedAnalystScore can reach it.
    const agent = readFileSync("lib/research-agent.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    expect(agent).toMatch(/fundamental:\s*!isEtf\s*&&\s*dq\.fundamentalDataAvailable\s*===\s*true/);
  });
});
