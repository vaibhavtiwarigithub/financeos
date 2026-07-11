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
});
