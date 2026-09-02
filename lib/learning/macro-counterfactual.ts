import {
  computeWeightedAnalystScore,
  SCORE_DIMENSIONS,
  type DimensionRecord,
} from "@/lib/scoring/weighted-score";
import { capEtfLikeScore } from "@/lib/scoring/archetypes";

/**
 * Stage 1 of the macro-dimension role correction (measure-only).
 * features/macro-dimension-role/FEATURE_ARCHITECTURE.md
 *
 * WHAT THIS ANSWERS. `macro_score` is a single market-wide scalar on any given
 * day, so `0.15 * macro` is identical for every candidate and CANNOT change the
 * ordering of candidates — dropping it and renormalizing yields a positive
 * scalar multiple of the same quantity. Its entire effect is on the LEVEL of
 * every score at once, and therefore on HOW MANY candidates clear the absolute
 * entry threshold. This module quantifies that: for each recorded decision, what
 * the score and eligibility would have been with macro excluded.
 *
 * NOTHING HERE IS ON THE MONEY PATH. It reads the immutable decision ledger and
 * returns numbers. It cannot change a score, a signal, a fill, a size or an exit.
 *
 * REPLAY FIDELITY IS CHECKED, NOT ASSUMED. Every row is first re-scored WITH
 * macro using the production scorer (`computeWeightedAnalystScore`, the same
 * function research-agent.ts and the Validation Engine call). If that replay
 * does not reproduce the stored `analyst_score`, the counterfactual for that row
 * is not trustworthy and the row is reported as a mismatch instead of being
 * quietly counted. A counterfactual built on a replay that cannot reproduce the
 * present is worthless.
 */

export type MacroCounterfactualRow = {
  /** Effective (already renormalized) weights recorded at decision time. */
  weightsUsed: DimensionRecord<number>;
  included: DimensionRecord<boolean>;
  scores: DimensionRecord<number>;
  /** Stored analyst_score, as production rounded it. */
  observedScore: number;
  threshold: number;
  observedEligible: boolean;
  /**
   * ETF, leveraged/inverse ETF or metal fund. Production caps these at
   * ETF_SCORE_CAP (65) AFTER weighting (research-agent.ts:1714), because an
   * ETF's technical dimension dominates once fundamentals renormalize away.
   *
   * Omitting this cap is a KNOWN replay trap: the Evidence Router hit exactly
   * it — "recorded=65, replayed=<uncapped>", 45 failures across 8 symbols, over
   * half of all US parity failures — which is why `capEtfLikeScore` was
   * exported in the first place. This module's first run repeated the mistake
   * and reported an 86.5% match rate until the cap was applied.
   */
  isEtfLike: boolean;
};

export type MacroCounterfactualResult = {
  replayScore: number;
  replayMatches: boolean;
  counterfactualScore: number;
  /** Fewer than two dimensions survive macro's removal — score is meaningless. */
  counterfactualAbstains: boolean;
  macroWasIncluded: boolean;
  /**
   * Eligible under the counterfactual, judged on the score gate ALONE.
   * See `classifyFlip` for why this is not the same as "would have traded".
   */
  counterfactualPassesScoreGate: boolean;
  delta: number;
};

/**
 * Passing the recorded EFFECTIVE weights as `baseWeights` is exact, not an
 * approximation. Effective weights are base weights divided by the included
 * total, so among the surviving dimensions they stay proportional to the base
 * weights; renormalizing them over the macro-less set gives
 * `w_k / (1 - w_macro)`, which is what production would have produced had macro
 * been unavailable. This deliberately reuses the production scorer rather than
 * re-deriving the arithmetic, so the two cannot drift apart.
 */
export function macroCounterfactual(row: MacroCounterfactualRow): MacroCounterfactualResult {
  const macroWasIncluded = row.included.macro === true;

  const replay = computeWeightedAnalystScore(row.scores, row.included, row.weightsUsed);
  const replayScore = capEtfLikeScore(replay.score, row.isEtfLike);
  const replayMatches = replayScore === row.observedScore;

  const withoutMacro: DimensionRecord<boolean> = { ...row.included, macro: false };
  const counterfactual = computeWeightedAnalystScore(row.scores, withoutMacro, row.weightsUsed);
  // The cap applies to the counterfactual too. For an ETF already above 65 both
  // with and WITHOUT macro, the cap absorbs the whole macro term — macro cannot
  // move its eligibility at all, and 65 clears the 60 threshold either way.
  const counterfactualScore = capEtfLikeScore(counterfactual.score, row.isEtfLike);

  return {
    replayScore,
    replayMatches,
    counterfactualScore,
    counterfactualAbstains: counterfactual.abstain,
    macroWasIncluded,
    counterfactualPassesScoreGate: !counterfactual.abstain && counterfactualScore >= row.threshold,
    delta: counterfactualScore - replayScore,
  };
}

export type FlipClass =
  /** Was eligible; loses the score gate without macro. Certain. */
  | "loses_eligibility"
  /** Was not eligible and the score was the visible blocker; may gain it. Upper bound. */
  | "may_gain_eligibility"
  /** Eligible before and after. */
  | "unchanged_eligible"
  /** Not eligible before or after. */
  | "unchanged_ineligible"
  /** Score cleared the threshold yet the decision was not eligible: some gate
   *  other than the score blocked it (earnings repricing pending, or the
   *  technical breakdown veto). Those gates are independent of macro, so they
   *  block the counterfactual too. */
  | "blocked_by_other_gate"
  /** Macro was never in this score (India, or a stale/absent regime row). */
  | "macro_not_included";

/**
 * ASYMMETRY, AND IT IS NOT COSMETIC.
 *
 * `entry_eligible` is `!earningsRepricing.pending && !breakdownVetoed &&
 * direction === 'long' && analystScore >= threshold` (research-agent.ts:1933).
 * The decision ledger records the score and the threshold but NOT the earnings
 * or breakdown gates.
 *
 * So the two directions are not equally knowable:
 *
 *  - A row that WAS eligible had every other gate passing. If its
 *    counterfactual score drops below the threshold it loses eligibility —
 *    CERTAIN.
 *  - A row that was NOT eligible may have been blocked by the score, by
 *    earnings, by the breakdown veto, or by several at once. A counterfactual
 *    score above the threshold therefore only means it MIGHT have become
 *    eligible — an UPPER BOUND, never a count of trades that would have happened.
 *
 * Reporting the second as if it were the first would overstate the effect in the
 * flattering direction, which is the whole reason the two are separated here.
 */
export function classifyFlip(row: MacroCounterfactualRow, result: MacroCounterfactualResult): FlipClass {
  if (!result.macroWasIncluded) return "macro_not_included";
  if (row.observedEligible) {
    return result.counterfactualPassesScoreGate ? "unchanged_eligible" : "loses_eligibility";
  }
  // Not eligible, yet the score cleared the bar → a non-score gate blocked it,
  // and that gate is macro-independent.
  if (row.observedScore >= row.threshold) return "blocked_by_other_gate";
  return result.counterfactualPassesScoreGate ? "may_gain_eligibility" : "unchanged_ineligible";
}

export type MacroShadowSummary = {
  observations: number;
  /**
   * Rows the replay reproduced, and therefore the ONLY rows the flip counts are
   * computed over. A row whose present cannot be reproduced cannot have its
   * counterfactual trusted, so it is excluded rather than guessed at — dropping
   * it from the denominator too, or it would dilute the rate it is not part of.
   */
  analysedObservations: number;
  replayMismatches: number;
  replayMatchRate: number;
  /**
   * Largest |replay - observed| among mismatching rows. A mismatch rate is not
   * enough on its own: 3% of rows off by 1 point is rounding, 3% off by 20 is a
   * missing rule. Reporting only the rate cannot tell those apart, and they
   * demand opposite responses.
   */
  replayMaxAbsMismatch: number;
  /** Mismatching rows that are off by exactly 1 — i.e. attributable to rounding. */
  replayMismatchesWithinOne: number;
  macroIncluded: number;
  meanDelta: number | null;
  /** Certain losses (see classifyFlip). */
  losesEligibility: number;
  /** Upper bound on gains (see classifyFlip). */
  mayGainEligibility: number;
  unchangedEligible: number;
  unchangedIneligible: number;
  blockedByOtherGate: number;
  macroNotIncluded: number;
  /** Fraction of decisions whose eligibility could move, on the certain side. */
  certainFlipRate: number;
};

export function summarize(rows: MacroCounterfactualRow[]): MacroShadowSummary {
  const counts: Record<FlipClass, number> = {
    loses_eligibility: 0,
    may_gain_eligibility: 0,
    unchanged_eligible: 0,
    unchanged_ineligible: 0,
    blocked_by_other_gate: 0,
    macro_not_included: 0,
  };
  let mismatches = 0;
  let mismatchesWithinOne = 0;
  let maxAbsMismatch = 0;
  let macroIncluded = 0;
  const deltas: number[] = [];

  for (const row of rows) {
    const result = macroCounterfactual(row);
    if (!result.replayMatches) {
      mismatches++;
      const gap = Math.abs(result.replayScore - row.observedScore);
      if (gap <= 1) mismatchesWithinOne++;
      if (gap > maxAbsMismatch) maxAbsMismatch = gap;
      continue; // unreplayable → uncounterfactualable
    }
    if (result.macroWasIncluded) {
      macroIncluded++;
      deltas.push(result.delta);
    }
    counts[classifyFlip(row, result)]++;
  }

  const n = rows.length;
  const analysed = n - mismatches;
  return {
    observations: n,
    analysedObservations: analysed,
    replayMismatches: mismatches,
    replayMatchRate: n ? (n - mismatches) / n : 0,
    replayMaxAbsMismatch: maxAbsMismatch,
    replayMismatchesWithinOne: mismatchesWithinOne,
    macroIncluded,
    meanDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    losesEligibility: counts.loses_eligibility,
    mayGainEligibility: counts.may_gain_eligibility,
    unchangedEligible: counts.unchanged_eligible,
    unchangedIneligible: counts.unchanged_ineligible,
    blockedByOtherGate: counts.blocked_by_other_gate,
    macroNotIncluded: counts.macro_not_included,
    certainFlipRate: analysed ? counts.loses_eligibility / analysed : 0,
  };
}

/** Coerce a stored jsonb record into a full DimensionRecord, defaulting missing keys. */
export function toDimensionRecord<T>(raw: unknown, fallback: T): DimensionRecord<T> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out = {} as DimensionRecord<T>;
  for (const dimension of SCORE_DIMENSIONS) {
    const value = source[dimension];
    out[dimension] = (value === undefined || value === null ? fallback : value) as T;
  }
  return out;
}
