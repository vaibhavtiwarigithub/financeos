import { describe, expect, it } from "vitest";
import {
  macroCounterfactual,
  classifyFlip,
  summarize,
  toDimensionRecord,
  type MacroCounterfactualRow,
} from "@/lib/learning/macro-counterfactual";
import { computeWeightedAnalystScore } from "@/lib/scoring/weighted-score";

// Stage 1 of features/macro-dimension-role: measure what excluding macro would
// have done to recorded decisions. Measure-only — nothing here reaches a score,
// signal, fill, size or exit.

const BASE = { fundamental: 0.30, technical: 0.25, sentiment: 0.20, macro: 0.15, insider: 0.10 };
const ALL_IN = { fundamental: true, technical: true, sentiment: true, macro: true, insider: true };

function row(over: Partial<MacroCounterfactualRow> = {}): MacroCounterfactualRow {
  const scores = { fundamental: 60, technical: 60, sentiment: 60, macro: 69, insider: 60, ...(over.scores ?? {}) };
  const included = { ...ALL_IN, ...(over.included ?? {}) };
  const weightsUsed = { ...BASE, ...(over.weightsUsed ?? {}) };
  const observedScore = over.observedScore
    ?? computeWeightedAnalystScore(scores, included, weightsUsed).score;
  return {
    scores, included, weightsUsed, observedScore,
    threshold: over.threshold ?? 60,
    observedEligible: over.observedEligible ?? observedScore >= (over.threshold ?? 60),
    isEtfLike: over.isEtfLike ?? false,
  };
}

describe("macro is a level shift, never a re-ranking", () => {
  it("removing macro preserves the ORDER of candidates", () => {
    // The load-bearing claim of the whole feature. macro is one scalar shared by
    // every candidate on a day, so 0.15*macro is a common additive term;
    // removing it and renormalizing is a positive scalar multiple. If this test
    // ever fails, the premise for changing macro's role is gone.
    const candidates = [
      { fundamental: 80, technical: 20, sentiment: 55, macro: 69, insider: 40 },
      { fundamental: 30, technical: 90, sentiment: 65, macro: 69, insider: 10 },
      { fundamental: 55, technical: 55, sentiment: 20, macro: 69, insider: 95 },
      { fundamental: 10, technical: 15, sentiment: 90, macro: 69, insider: 60 },
    ];
    const rows = candidates.map((scores) => row({ scores }));
    const actual = rows.map((r) => macroCounterfactual(r).replayScore);
    const counter = rows.map((r) => macroCounterfactual(r).counterfactualScore);

    const orderOf = (values: number[]) =>
      values.map((_, i) => i).sort((a, b) => values[b] - values[a]);
    expect(orderOf(counter)).toEqual(orderOf(actual));
  });

  it("shifts every candidate by the same direction when macro is above the rest", () => {
    // macro 69 against a book scoring ~40 props the whole book UP; removing it
    // must lower every score, not a selected few.
    const rows = [30, 40, 50].map((v) =>
      row({ scores: { fundamental: v, technical: v, sentiment: v, macro: 69, insider: v } }));
    for (const r of rows) expect(macroCounterfactual(r).delta).toBeLessThan(0);
  });
});

describe("replay fidelity gate", () => {
  it("reproduces the stored score with the production scorer", () => {
    const r = row();
    const result = macroCounterfactual(r);
    expect(result.replayMatches).toBe(true);
    expect(result.replayScore).toBe(r.observedScore);
  });

  it("flags a row it cannot reproduce instead of silently counting it", () => {
    // A counterfactual built on a replay that cannot reproduce the PRESENT is
    // worthless, so a mismatch has to surface rather than average away.
    const r = row({ observedScore: 99 });
    expect(macroCounterfactual(r).replayMatches).toBe(false);
    expect(summarize([r]).replayMismatches).toBe(1);
    expect(summarize([r]).replayMatchRate).toBe(0);
  });

  it("excludes unreplayable rows from the flip counts AND the denominator", () => {
    // Production hit this: 149 of 158 mismatches sit in 2026-07-06..07-22, a
    // legacy cohort scored before the ETF cap existed (ETFs recorded at 100
    // where the capped replay says 65, a 35-point gap). Counting those rows as
    // "unchanged" would quietly assert a counterfactual for decisions whose
    // PRESENT cannot be reproduced, and would inflate the denominator that the
    // flip rate is measured against.
    const good = row({ scores: { fundamental: 55, technical: 55, sentiment: 55, macro: 100, insider: 55 }, threshold: 60, observedEligible: true });
    const bad = row({ observedScore: 99 });
    const s = summarize([good, bad]);
    expect(s.observations).toBe(2);
    expect(s.analysedObservations).toBe(1);
    expect(s.losesEligibility).toBe(1);
    // Denominator is the analysed row only, so the rate is 1/1, not 1/2.
    expect(s.certainFlipRate).toBe(1);
  });
});

describe("effective-weight renormalization is exact", () => {
  it("matches base-weight renormalization when a dimension was already excluded", () => {
    // insider unavailable -> stored effective weights are base/0.90. Removing
    // macro from THOSE must equal renormalizing the base weights over the
    // remaining three, or the counterfactual silently uses the wrong mix.
    const included = { ...ALL_IN, insider: false };
    const effective = {
      fundamental: 0.30 / 0.90, technical: 0.25 / 0.90, sentiment: 0.20 / 0.90,
      macro: 0.15 / 0.90, insider: 0,
    };
    const scores = { fundamental: 70, technical: 40, sentiment: 80, macro: 69, insider: 50 };
    const r = row({ scores, included, weightsUsed: effective });

    const viaModule = macroCounterfactual(r).counterfactualScore;
    const viaBase = computeWeightedAnalystScore(
      scores, { ...included, macro: false }, BASE,
    ).score;
    expect(viaModule).toBe(viaBase);
  });
});

describe("flip classification keeps certain and speculative apart", () => {
  it("an eligible row losing the score gate is a CERTAIN loss", () => {
    // High macro carrying a weak book over the line.
    const scores = { fundamental: 55, technical: 55, sentiment: 55, macro: 100, insider: 55 };
    const r = row({ scores, threshold: 60, observedEligible: true });
    expect(macroCounterfactual(r).counterfactualPassesScoreGate).toBe(false);
    expect(classifyFlip(r, macroCounterfactual(r))).toBe("loses_eligibility");
  });

  it("an ineligible row clearing the gate is only an UPPER BOUND", () => {
    // Low macro dragging an otherwise-strong book under the line.
    const scores = { fundamental: 65, technical: 65, sentiment: 65, macro: 10, insider: 65 };
    const r = row({ scores, threshold: 60, observedEligible: false });
    expect(classifyFlip(r, macroCounterfactual(r))).toBe("may_gain_eligibility");
  });

  it("a row that scored above threshold yet was ineligible is attributed to another gate", () => {
    // entry_eligible also requires !earningsRepricing.pending && !breakdownVetoed,
    // neither of which is in the ledger. Those gates are macro-independent, so
    // such a row must NOT be counted as a macro-driven gain.
    const scores = { fundamental: 90, technical: 90, sentiment: 90, macro: 90, insider: 90 };
    const r = row({ scores, threshold: 60, observedEligible: false });
    expect(r.observedScore).toBeGreaterThanOrEqual(60);
    expect(classifyFlip(r, macroCounterfactual(r))).toBe("blocked_by_other_gate");
    expect(summarize([r]).mayGainEligibility).toBe(0);
  });

  it("leaves India-style rows alone when macro was never included", () => {
    const included = { ...ALL_IN, macro: false };
    const r = row({ included, weightsUsed: { fundamental: 0.353, technical: 0.294, sentiment: 0.235, macro: 0, insider: 0.118 } });
    const result = macroCounterfactual(r);
    expect(result.macroWasIncluded).toBe(false);
    expect(result.counterfactualScore).toBe(result.replayScore);
    expect(classifyFlip(r, result)).toBe("macro_not_included");
  });
});

describe("abstain guard", () => {
  it("treats a sub-two-dimension counterfactual as abstain, not as a score", () => {
    // Only macro + fundamental available: removing macro leaves ONE dimension,
    // which computeWeightedAnalystScore marks abstain. Counting that as a
    // passing score would invent eligibility from a single input.
    const included = { fundamental: true, technical: false, sentiment: false, macro: true, insider: false };
    const r = row({
      included,
      weightsUsed: { fundamental: 0.30 / 0.45, technical: 0, sentiment: 0, macro: 0.15 / 0.45, insider: 0 },
      scores: { fundamental: 95, technical: 0, sentiment: 0, macro: 20, insider: 0 },
    });
    const result = macroCounterfactual(r);
    expect(result.counterfactualAbstains).toBe(true);
    expect(result.counterfactualPassesScoreGate).toBe(false);
  });
});

describe("ETF score cap", () => {
  // THE DEFECT THIS PREVENTS, twice over. Production caps ETF-like scores at
  // ETF_SCORE_CAP=65 AFTER weighting (research-agent.ts:1714). A replay that
  // skips the cap reports an uncapped 82-85 against a recorded 65 and calls it a
  // mismatch. The Evidence Router hit exactly this — "recorded=65,
  // replayed=<uncapped>", 45 failures across 8 symbols — and this module's first
  // production run repeated it: 768 of 5,672 US rows failed, an 86.5% match rate,
  // every one an ETF with fundamental excluded.
  const etfScores = { fundamental: 0, technical: 95, sentiment: 90, macro: 69, insider: 0 };
  const etfIncluded = { fundamental: false, technical: true, sentiment: true, macro: true, insider: false };
  const etfWeights = { fundamental: 0, technical: 0.4166666666666667, sentiment: 0.33333333333333337, macro: 0.25, insider: 0 };

  it("reproduces a capped ETF score that an uncapped replay would miss", () => {
    const r = row({ scores: etfScores, included: etfIncluded, weightsUsed: etfWeights, observedScore: 65, isEtfLike: true });
    const result = macroCounterfactual(r);
    expect(result.replayScore).toBe(65);
    expect(result.replayMatches).toBe(true);

    // Same row treated as a non-ETF: uncapped, and it does NOT reproduce.
    const uncapped = macroCounterfactual({ ...r, isEtfLike: false });
    expect(uncapped.replayScore).toBeGreaterThan(65);
    expect(uncapped.replayMatches).toBe(false);
  });

  it("macro cannot move an ETF pinned to the cap on both sides", () => {
    // Capped with macro AND without it, so the cap absorbs the entire macro
    // term. 65 clears the 60 threshold either way — macro is irrelevant to this
    // row's eligibility, and it must not be counted as a flip.
    const r = row({ scores: etfScores, included: etfIncluded, weightsUsed: etfWeights, observedScore: 65, isEtfLike: true, observedEligible: true });
    const result = macroCounterfactual(r);
    expect(result.counterfactualScore).toBe(65);
    expect(result.delta).toBe(0);
    expect(classifyFlip(r, result)).toBe("unchanged_eligible");
  });
});

describe("toDimensionRecord", () => {
  it("fills every dimension and defaults missing keys", () => {
    expect(toDimensionRecord({ macro: 0.15 }, 0)).toEqual({
      fundamental: 0, technical: 0, sentiment: 0, macro: 0.15, insider: 0,
    });
    expect(toDimensionRecord(null, false)).toEqual({
      fundamental: false, technical: false, sentiment: false, macro: false, insider: false,
    });
  });
});
