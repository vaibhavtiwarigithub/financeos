import { describe, it, expect } from "vitest";
import { computeWeightedAnalystScore, isThinEvidence } from "@/lib/scoring/weighted-score";

const W = { fundamental: 0.30, technical: 0.25, sentiment: 0.20, macro: 0.15, insider: 0.10 };
const S = { fundamental: 80, technical: 60, sentiment: 50, macro: 40, insider: 70 };
const allIn = { fundamental: true, technical: true, sentiment: true, macro: true, insider: true };

describe("weighted-score: computeWeightedAnalystScore", () => {
  it("all 5 dims: weighted sum, no renormalization, not abstain", () => {
    const r = computeWeightedAnalystScore(S, allIn, W);
    // 80*.3 + 60*.25 + 50*.2 + 40*.15 + 70*.1 = 24+15+10+6+7 = 62
    expect(r.score).toBe(62);
    expect(r.renormalized).toBe(false);
    expect(r.abstain).toBe(false);
    expect(r.includedDims.length).toBe(5);
  });

  it("3 dims included: renormalizes weights to sum 1.0, not abstain", () => {
    const included = { fundamental: true, technical: true, sentiment: true, macro: false, insider: false };
    const r = computeWeightedAnalystScore(S, included, W);
    expect(r.renormalized).toBe(true);
    expect(r.abstain).toBe(false);
    const sum = r.includedDims.reduce((a, d) => a + r.effWeights[d], 0);
    expect(sum).toBeCloseTo(1.0, 6);
    // excluded dims carry zero weight
    expect(r.effWeights.macro).toBe(0);
    expect(r.effWeights.insider).toBe(0);
  });

  it("1 dim included: abstain flag true (score meaningless)", () => {
    const included = { fundamental: true, technical: false, sentiment: false, macro: false, insider: false };
    const r = computeWeightedAnalystScore(S, included, W);
    expect(r.abstain).toBe(true);
  });

  it("0 dims included: abstain, all effective weights zero", () => {
    const none = { fundamental: false, technical: false, sentiment: false, macro: false, insider: false };
    const r = computeWeightedAnalystScore(S, none, W);
    expect(r.abstain).toBe(true);
    expect(Object.values(r.effWeights).every((w) => w === 0)).toBe(true);
  });

  it("isThinEvidence: <2 dims is thin", () => {
    expect(isThinEvidence(["fundamental"])).toBe(true);
    expect(isThinEvidence(["fundamental", "technical"])).toBe(false);
  });

  it.each([NaN, Infinity, -0.1, undefined, null])("rejects invalid weights: %s", (bad) => {
    expect(() => computeWeightedAnalystScore(S, allIn, { ...W, fundamental: bad as number })).toThrow(/weight/i);
  });

  it.each([0, 0.5, 2])("rejects weights totaling %s instead of silently rescaling", (total) => {
    const weights = { fundamental: total, technical: 0, sentiment: 0, macro: 0, insider: 0 };
    expect(() => computeWeightedAnalystScore(S, allIn, weights)).toThrow(/sum to 1/);
  });

  it.each([NaN, Infinity, -1, 101, null, undefined])("rejects an included invalid score: %s", (bad) => {
    expect(() => computeWeightedAnalystScore({ ...S, fundamental: bad as number }, allIn, W)).toThrow(/dimension score/);
  });

  it("ignores unavailable nonfinite values and leaves inputs unchanged", () => {
    const scores = Object.freeze({ ...S, macro: NaN, insider: Infinity });
    const included = Object.freeze({ ...allIn, macro: false, insider: false });
    const result = computeWeightedAnalystScore(scores, included, Object.freeze({ ...W }));
    expect(result.score).toBe(65);
    expect(result.effWeights.macro).toBe(0);
    expect(result.effWeights.insider).toBe(0);
  });

  it("single-dimension abstention excludes finite placeholders as well as nonfinite values", () => {
    const included = { fundamental: true, technical: false, sentiment: false, macro: false, insider: false };
    const result = computeWeightedAnalystScore({ ...S, technical: NaN }, included, W);
    expect(result.score).toBe(24);
    expect(result.abstain).toBe(true);
    expect(result.effWeights.technical).toBe(0);
  });

  it("requires explicit boolean availability", () => {
    expect(() => computeWeightedAnalystScore(S, { ...allIn, macro: undefined as unknown as boolean }, W)).toThrow(/availability/);
  });
});
