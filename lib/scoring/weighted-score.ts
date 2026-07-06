// Shared weighted-analyst-score contract. Used by BOTH the live ResearchAgent
// (lib/research-agent.ts) and the offline Validation Engine
// (lib/validation/engine.ts) so a challenger is always evaluated against the
// exact scoring rule that will run live — before this module existed, the
// Validation Engine coalesced missing scores to 50 with a fixed 5-way weight
// split while production excluded/renormalized, so a challenger could pass or
// fail on an objective different from the one that actually governs trading.

export type ScoreDimension = "fundamental" | "technical" | "sentiment" | "macro" | "insider";

export const SCORE_DIMENSIONS: ScoreDimension[] = ["fundamental", "technical", "sentiment", "macro", "insider"];

export type DimensionRecord<T> = Record<ScoreDimension, T>;

export interface WeightedScoreResult {
  score: number;
  effWeights: DimensionRecord<number>;
  renormalized: boolean;
  includedDims: ScoreDimension[];
}

// Renormalizes `baseWeights` across only the dimensions flagged `true` in
// `included`, then computes the weighted score. Falls back to the fixed
// `baseWeights` split when fewer than 2 dimensions are included (renormalizing
// to 100% on one thin signal is riskier than the fixed split in that
// degenerate case) — mirrors the prior research-agent.ts-only logic exactly,
// now shared so validation replays it identically.
export function computeWeightedAnalystScore(
  scores: DimensionRecord<number>,
  included: DimensionRecord<boolean>,
  baseWeights: DimensionRecord<number>
): WeightedScoreResult {
  const includedDims = SCORE_DIMENSIONS.filter(k => included[k]);
  let effWeights: DimensionRecord<number> = { ...baseWeights };
  let renormalized = false;

  if (includedDims.length >= 2 && includedDims.length < SCORE_DIMENSIONS.length) {
    const totalIncluded = includedDims.reduce((s, k) => s + baseWeights[k], 0);
    const next: DimensionRecord<number> = { fundamental: 0, technical: 0, sentiment: 0, macro: 0, insider: 0 };
    if (totalIncluded > 0) {
      for (const k of includedDims) next[k] = baseWeights[k] / totalIncluded;
    } else {
      // Every included dimension's configured weight is 0 (deliberately zeroed
      // custom config) — equal split instead of leaving analystScore at 0.
      for (const k of includedDims) next[k] = 1 / includedDims.length;
    }
    effWeights = next;
    renormalized = true;
  } else if (includedDims.length === 0) {
    // No usable evidence at all — every weight is 0. Caller MUST treat this
    // as abstain-worthy (score is meaningless), not just a low score.
    effWeights = { fundamental: 0, technical: 0, sentiment: 0, macro: 0, insider: 0 };
  }

  const score = SCORE_DIMENSIONS.reduce((s, k) => s + scores[k] * effWeights[k], 0);
  return { score: Math.round(score), effWeights, renormalized, includedDims };
}

// Minimum-evidence gate: fewer than 2 included dimensions means the score is
// built on too little to trust as a directional signal.
export function isThinEvidence(includedDims: ScoreDimension[]): boolean {
  return includedDims.length < 2;
}
