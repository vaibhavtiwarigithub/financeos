// Phase 2 learning-core: Validation Engine. Deterministic — NO LLM anywhere in
// this file. Replays champion vs challenger weights against the SAME held-out
// opportunity set (walk-forward folds from the decision ledger) and requires
// statistical evidence of improvement before a challenger may be promoted.
//
// This is a scoring-REPLAY, not a refit: for each historical observation we
// recompute what score challenger/champion weights would have produced, then
// look up what actually happened (benchmark_neutral_return). No new data is
// invented; nothing here touches live trading.

import crypto from "crypto";
import { loadLabeledDataset, walkForwardFolds, type LabeledObservation } from "@/lib/learning/dataset";

export interface ValidationResult {
  passed: boolean;
  failReason?: string;
  experimentId?: number;
  challengerScore: number;
  championScore: number;
  pImprovement: number;
  nEffective: number;
}

const BALANCED_WEIGHTS: Record<string, number> = {
  fundamental: 0.30, technical: 0.25, sentiment: 0.20, macro: 0.15, insider: 0.10,
};

function readWeight(snapshot: Record<string, any> | null, short: string): number {
  if (!snapshot) return BALANCED_WEIGHTS[short];
  const v = snapshot[short] ?? snapshot[`${short}_weight`];
  return typeof v === "number" ? v : BALANCED_WEIGHTS[short];
}

function weightsFromSnapshot(snapshot: Record<string, any> | null): Record<string, number> {
  return {
    fundamental: readWeight(snapshot, "fundamental"),
    technical: readWeight(snapshot, "technical"),
    sentiment: readWeight(snapshot, "sentiment"),
    macro: readWeight(snapshot, "macro"),
    insider: readWeight(snapshot, "insider"),
  };
}

function scoreRow(weights: Record<string, number>, row: LabeledObservation): number {
  return (
    (row.fundamental_score ?? 50) * weights.fundamental +
    (row.technical_score ?? 50) * weights.technical +
    (row.sentiment_score ?? 50) * weights.sentiment +
    (row.macro_score ?? 50) * weights.macro +
    (row.insider_score ?? 50) * weights.insider
  );
}

// Objective term for one row under one weight set: log-growth if the score
// would have cleared this row's OWN recorded entry threshold, else 0 (not taken).
function objectiveTerm(weights: Record<string, number>, row: LabeledObservation): number {
  const score = scoreRow(weights, row);
  const threshold = row.score_threshold ?? 60;
  if (score < threshold) return 0;
  const ret = row.benchmark_neutral_return ?? row.fwd_return ?? 0;
  return Math.log(1 + ret);
}

// Deterministic seeded PRNG (mulberry32) — reproducible experiments (fixed seed).
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Moving-block bootstrap over a time-ordered series of paired differences.
// Returns { ciLow, ciHigh, pImprovement } from `resamples` resampled means.
function blockBootstrap(diffs: number[], blockLen: number, resamples: number, seed: number) {
  const n = diffs.length;
  if (n === 0) return { ciLow: 0, ciHigh: 0, pImprovement: 0 };
  const rng = mulberry32(seed);
  const means: number[] = [];
  const effectiveBlockLen = Math.max(1, Math.min(blockLen, n));
  for (let r = 0; r < resamples; r++) {
    const resampled: number[] = [];
    while (resampled.length < n) {
      const start = Math.floor(rng() * (n - effectiveBlockLen + 1));
      for (let i = 0; i < effectiveBlockLen && resampled.length < n; i++) resampled.push(diffs[start + i]);
    }
    means.push(resampled.reduce((a, b) => a + b, 0) / resampled.length);
  }
  means.sort((a, b) => a - b);
  const ciLow = means[Math.floor(0.025 * resamples)];
  const ciHigh = means[Math.floor(0.975 * resamples)];
  const pImprovement = means.filter(m => m > 0).length / resamples;
  return { ciLow, ciHigh, pImprovement };
}

export async function validateChallenger(supabase: any, opts: {
  market: "us" | "india"; challengerId: number; horizonDays?: 2 | 5 | 10 | 20;
}): Promise<ValidationResult> {
  const horizonDays = opts.horizonDays ?? 10;
  const market = opts.market;

  const { data: challengerRow } = await supabase
    .from("strategy_versions").select("id, weights_snapshot").eq("id", opts.challengerId).maybeSingle();
  if (!challengerRow) {
    return { passed: false, failReason: "challenger_not_found", challengerScore: 0, championScore: 0, pImprovement: 0, nEffective: 0 };
  }
  const { data: championRow } = await supabase
    .from("strategy_versions").select("id, weights_snapshot").eq("market", market).eq("is_champion", true)
    .order("promoted_at", { ascending: false }).limit(1).maybeSingle();

  const challengerWeights = weightsFromSnapshot(challengerRow.weights_snapshot);
  const championWeights = weightsFromSnapshot(championRow?.weights_snapshot ?? null);

  const rows = await loadLabeledDataset(supabase, market, horizonDays);
  const nObservations = rows.length;

  async function recordExperiment(result: Omit<ValidationResult, "experimentId">, extra: Record<string, any>): Promise<number | undefined> {
    const datasetHash = crypto.createHash("sha256")
      .update(JSON.stringify(rows.map(r => [r.id, r.fwd_return]))).digest("hex");
    const { data } = await supabase.from("validation_experiments").insert({
      market, challenger_id: opts.challengerId, champion_id: championRow?.id ?? null,
      horizon_days: horizonDays, dataset_hash: datasetHash, n_observations: nObservations,
      n_effective: result.nEffective, objective: "benchmark_neutral_log_growth",
      challenger_score: result.challengerScore, champion_score: result.championScore,
      p_improvement: result.pImprovement, passed: result.passed, fail_reason: result.failReason ?? null,
      config: { seed: 42, resamples: 1000, blockLen: horizonDays, ...extra },
      ...extra,
    }).select("id").maybeSingle();
    if (data?.id) await supabase.from("strategy_versions").update({ validation_experiment_id: data.id }).eq("id", opts.challengerId);
    return data?.id;
  }

  if (nObservations < 60) {
    const result: ValidationResult = { passed: false, failReason: "insufficient_data(<60)", challengerScore: 0, championScore: 0, pImprovement: 0, nEffective: nObservations / horizonDays };
    result.experimentId = await recordExperiment(result, { folds: [] });
    return result;
  }

  const folds = walkForwardFolds(rows, { folds: 5, testDays: 30, horizonDays });
  if (folds.length === 0) {
    const result: ValidationResult = { passed: false, failReason: "no_valid_folds", challengerScore: 0, championScore: 0, pImprovement: 0, nEffective: nObservations / horizonDays };
    result.experimentId = await recordExperiment(result, { folds: [] });
    return result;
  }

  // Paired per-row objective differences across ALL test rows (concatenated,
  // chronological — matches the ledger's natural order since folds are anchored).
  const pairedDiffs: number[] = [];
  const foldResults: { trainEnd: string; testEnd: string; challengerMean: number; championMean: number; challengerWins: boolean }[] = [];
  for (const fold of folds) {
    const foldDiffs = fold.test.map(row => objectiveTerm(challengerWeights, row) - objectiveTerm(championWeights, row));
    pairedDiffs.push(...foldDiffs);
    const challengerMean = fold.test.reduce((s, r) => s + objectiveTerm(challengerWeights, r), 0) / fold.test.length;
    const championMean = fold.test.reduce((s, r) => s + objectiveTerm(championWeights, r), 0) / fold.test.length;
    foldResults.push({ trainEnd: fold.trainEnd, testEnd: fold.testEnd, challengerMean, championMean, challengerWins: challengerMean > championMean });
  }

  const challengerScore = rows.length ? rows.reduce((s, r) => s + objectiveTerm(challengerWeights, r), 0) / rows.length : 0;
  const championScore = rows.length ? rows.reduce((s, r) => s + objectiveTerm(championWeights, r), 0) / rows.length : 0;
  const nEffective = pairedDiffs.length / horizonDays;

  const { ciLow, ciHigh, pImprovement } = blockBootstrap(pairedDiffs, horizonDays, 1000, 42);
  const foldsWon = foldResults.filter(f => f.challengerWins).length;

  const EPSILON = 0.0005;
  let passed = true;
  let failReason: string | undefined;
  if (pImprovement < 0.80) { passed = false; failReason = `p_improvement ${pImprovement.toFixed(2)} < 0.80`; }
  else if (ciLow <= -EPSILON) { passed = false; failReason = `paired_diff_ci_low ${ciLow.toFixed(5)} <= -${EPSILON}`; }
  else if (nEffective < 12) { passed = false; failReason = `n_effective ${nEffective.toFixed(1)} < 12`; }
  else if (foldsWon < 3) { passed = false; failReason = `won only ${foldsWon}/${folds.length} folds (need >=3 of 5)`; }

  const result: ValidationResult = { passed, failReason, challengerScore, championScore, pImprovement, nEffective };
  result.experimentId = await recordExperiment(result, {
    paired_diff_mean: pairedDiffs.reduce((a, b) => a + b, 0) / pairedDiffs.length,
    paired_diff_ci_low: ciLow, paired_diff_ci_high: ciHigh, folds: foldResults,
  });
  return result;
}
