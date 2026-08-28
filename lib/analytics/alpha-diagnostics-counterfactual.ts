// Alpha Diagnostic Lab — counterfactual and robustness tests (A4-A8).
//
// A0-A3 in ./alpha-diagnostics.ts describe what happened. These four ask what
// WOULD have happened, which is where a diagnostic most easily fools itself, so
// each carries an explicit refusal for the case it cannot actually resolve.
//
// READ-ONLY. No provider call, no money-path import, no mutation.

import {
  type DiagnosticFinding,
  type DiagnosticMarket,
  type DiagnosticSample,
  sampleStatus,
} from "./alpha-diagnostic-contract";
import type { ClosedLot } from "./alpha-diagnostics";

const METRIC_VERSION = "alpha_diagnostics_v1";

// ── A4: exit precedence and counterfactual paths ─────────────────────────────

export type ExitResolution =
  | "target_first"
  | "stop_first"
  /** BOTH barriers were touched inside the window, and daily MFE/MAE cannot say
   *  which came first. Never resolved in favour of either side. */
  | "ambiguous"
  | "neither_touched";

/**
 * Resolve which barrier a lot reached, from excursions alone.
 *
 * THE GUARD THIS TEST EXISTS FOR: MFE and MAE are extremes over the WHOLE
 * window, so a lot whose MFE cleared the target and whose MAE breached the stop
 * touched both — and nothing in daily data says in what order. Assigning
 * `target_first` there manufactures a winner out of missing information, which
 * is precisely how a counterfactual exit study talks itself into a better
 * policy. Those rows are `ambiguous` and get no win/loss attribution.
 */
export function resolveExitPath(args: {
  mfe: number | null; mae: number | null; targetPct: number; stopPct: number;
}): ExitResolution {
  const { mfe, mae, targetPct, stopPct } = args;
  const hitTarget = mfe != null && Number.isFinite(mfe) && mfe * 100 >= targetPct;
  const hitStop = mae != null && Number.isFinite(mae) && mae * 100 <= -Math.abs(stopPct);
  if (hitTarget && hitStop) return "ambiguous";
  if (hitTarget) return "target_first";
  if (hitStop) return "stop_first";
  return "neither_touched";
}

export interface ExitPathLot extends ClosedLot {
  targetPct: number;
  stopPct: number;
}

export function runA4ExitPaths(market: DiagnosticMarket, lots: ExitPathLot[]): DiagnosticFinding {
  const tally: Record<ExitResolution, number> = {
    target_first: 0, stop_first: 0, ambiguous: 0, neither_touched: 0,
  };
  for (const l of lots) tally[resolveExitPath(l)]++;

  const byExitReason: Record<string, number> = {};
  for (const l of lots) {
    const k = l.exitReason ?? "(none)";
    byExitReason[k] = (byExitReason[k] ?? 0) + 1;
  }

  const resolvable = lots.length - tally.ambiguous;
  return {
    market, testId: "A4", cohort: "learning",
    window: { from: "", to: "" },
    sample: { nRows: lots.length, nDates: lots.length, nSymbols: new Set(lots.map(l => l.symbol)).size },
    // Coverage is the RESOLVABLE share, so an ambiguous-heavy cohort reports low
    // coverage rather than a confident-looking split.
    coverage: lots.length === 0 ? 0 : resolvable / lots.length,
    metricVersion: METRIC_VERSION,
    status: lots.length === 0 ? "insufficient_evidence" : "descriptive_only",
    reason: lots.length === 0
      ? "No lots with excursion data."
      : `${tally.ambiguous}/${lots.length} lot(s) touched both barriers and are ambiguous by construction; they receive no favourable assignment.`,
    metrics: { resolutions: tally, byExitReason, ambiguousShare: lots.length ? tally.ambiguous / lots.length : null },
  };
}

// ── A5: sizing attribution ───────────────────────────────────────────────────

export interface SizedLot {
  symbol: string;
  entryNotional: number;
  pnlPct: number;
  realizedPnl: number;
}

/** Average-rank Spearman between entry notional and later return. */
export function notionalReturnRankCorrelation(lots: SizedLot[]): number | null {
  const usable = lots.filter(l => Number.isFinite(l.entryNotional) && Number.isFinite(l.pnlPct));
  const n = usable.length;
  if (n < 3) return null;
  const rank = (vals: number[]) => {
    const idx = vals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array<number>(vals.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k].i] = avg;
      i = j + 1;
    }
    return out;
  };
  const rx = rank(usable.map(l => l.entryNotional));
  const ry = rank(usable.map(l => l.pnlPct));
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

/**
 * Sizing attribution.
 *
 * The equal-notional counterfactual answers exactly one question: would the SAME
 * selected names have produced a different currency outcome under flat sizing?
 * Total capital is held constant so any difference is attributable to allocation
 * alone. It diagnoses sizing; it deliberately returns no recommended size.
 */
export function runA5Sizing(market: DiagnosticMarket, lots: SizedLot[]): DiagnosticFinding {
  const usable = lots.filter(l => Number.isFinite(l.entryNotional) && l.entryNotional > 0);
  const sorted = [...usable].sort((a, b) => a.entryNotional - b.entryNotional);
  const n = sorted.length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const quartiles = [0, 1, 2, 3].map(q => {
    const bucket = sorted.filter((_, i) => Math.min(3, Math.floor((i * 4) / Math.max(1, n))) === q);
    return {
      quartile: q + 1,
      lots: bucket.length,
      meanEntryNotional: bucket.length ? sum(bucket.map(l => l.entryNotional)) / bucket.length : null,
      meanReturnPct: bucket.length ? sum(bucket.map(l => l.pnlPct)) / bucket.length : null,
      currencyPnl: sum(bucket.map(l => l.realizedPnl)),
    };
  });

  const totalNotional = sum(usable.map(l => l.entryNotional));
  const equalNotional = n > 0 ? totalNotional / n : 0;
  const actualPnl = sum(usable.map(l => l.realizedPnl));
  const equalWeightPnl = sum(usable.map(l => equalNotional * (l.pnlPct / 100)));

  return {
    market, testId: "A5", cohort: "learning",
    window: { from: "", to: "" },
    sample: { nRows: n, nDates: n, nSymbols: new Set(usable.map(l => l.symbol)).size },
    coverage: lots.length === 0 ? 0 : n / lots.length,
    metricVersion: METRIC_VERSION,
    status: n === 0 ? "insufficient_evidence" : "descriptive_only",
    reason: n === 0
      ? "No lots with a positive entry notional."
      : "Sizing attribution on the same selected names. Diagnostic only: it does not propose a size rule.",
    metrics: {
      quartiles,
      notionalReturnRankCorrelation: notionalReturnRankCorrelation(usable),
      actualCurrencyPnl: actualPnl,
      equalNotionalCurrencyPnl: equalWeightPnl,
      /** Positive => flat sizing would have done better on the same picks. */
      sizingCostCurrency: equalWeightPnl - actualPnl,
    },
  };
}

// ── A7: execution and cost stress ────────────────────────────────────────────

export const COST_STRESS_BPS = [0, 10, 25, 50] as const;

/** Net return after a round-trip cost in basis points. Applied to the RETURN so
 *  the same function serves a percentage and a currency cohort. */
export function netOfCost(returnPct: number, roundTripBps: number): number {
  return returnPct - roundTripBps / 100;
}

export function runA7CostStress(market: DiagnosticMarket, lots: ClosedLot[]): DiagnosticFinding {
  const rets = lots.map(l => l.pnlPct).filter(v => Number.isFinite(v));
  const grossMean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;

  const levels = COST_STRESS_BPS.map(bps => {
    const net = rets.map(r => netOfCost(r, bps));
    const mean = net.length ? net.reduce((a, b) => a + b, 0) / net.length : null;
    return {
      roundTripBps: bps,
      meanNetReturnPct: mean,
      // Null rather than a ratio when gross is non-positive: "80% of a negative
      // edge survived" is not a meaningful sentence and would read as a pass.
      survivingFraction: grossMean != null && grossMean > 0 && mean != null ? mean / grossMean : null,
      profitableLots: net.filter(r => r > 0).length,
    };
  });

  return {
    market, testId: "A7", cohort: "learning",
    window: { from: "", to: "" },
    sample: { nRows: lots.length, nDates: lots.length, nSymbols: new Set(lots.map(l => l.symbol)).size },
    coverage: lots.length === 0 ? 0 : rets.length / lots.length,
    metricVersion: METRIC_VERSION,
    status: rets.length === 0 ? "insufficient_evidence" : "descriptive_only",
    reason: rets.length === 0
      ? "No lots with a usable return."
      : "Cost stress. An edge that disappears by 25bps round trip is not an edge that survives execution.",
    metrics: { grossMeanReturnPct: grossMean, levels },
  };
}

// ── A8: robustness and falsification ─────────────────────────────────────────

/** Deterministic PRNG so a placebo run is reproducible from its seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded PRNG. Returns a copy; the input is untouched. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

/**
 * Label-permutation placebo.
 *
 * Recomputes the statistic against SHUFFLED outcomes many times. If the real
 * statistic sits comfortably inside the placebo distribution, the apparent edge
 * is what this procedure produces on noise. Reported as an empirical p-value:
 * the share of placebo runs matching or beating the real statistic in magnitude.
 */
export function placeboPValue(
  realStatistic: number,
  scores: number[],
  outcomes: number[],
  statistic: (s: number[], o: number[]) => number | null,
  iterations = 200,
  seed = 12345,
): { pValue: number; iterations: number; placeboMean: number | null } {
  if (scores.length !== outcomes.length || scores.length < 3) {
    return { pValue: 1, iterations: 0, placeboMean: null };
  }
  let atLeastAsExtreme = 0;
  let total = 0;
  let sum = 0;
  for (let i = 0; i < iterations; i++) {
    const shuffled = seededShuffle(outcomes, seed + i);
    const stat = statistic(scores, shuffled);
    if (stat == null || !Number.isFinite(stat)) continue;
    total++;
    sum += stat;
    if (Math.abs(stat) >= Math.abs(realStatistic)) atLeastAsExtreme++;
  }
  // No usable placebo draw is NO evidence of robustness, so the conservative
  // p-value is 1 — never 0, which would read as a decisive pass.
  if (total === 0) return { pValue: 1, iterations: 0, placeboMean: null };
  // (b+1)/(m+1), the standard unbiased permutation estimator, NOT b/m.
  //
  // b/m returns exactly 0 when no shuffle reaches the real statistic, and 0
  // clears every possible alpha — including a heavily trial-adjusted one. That
  // is a false certainty: with m permutations the smallest p-value the
  // experiment can actually resolve is 1/(m+1), and claiming more precision than
  // the resolution supports is how a multiple-testing correction gets defeated
  // by a number that was never measured.
  return {
    pValue: (atLeastAsExtreme + 1) / (total + 1),
    iterations: total,
    placeboMean: sum / total,
  };
}

/**
 * Multiple-testing adjusted hurdle (Sidak).
 *
 * Every configuration tried counts as a trial, including abandoned ones. Testing
 * 20 variants at p<0.05 gives a ~64% chance of at least one false positive; the
 * adjusted alpha is what makes a survivor mean anything.
 */
export function adjustedAlpha(baseAlpha: number, trials: number): number {
  const t = Math.max(1, Math.floor(trials));
  return 1 - Math.pow(1 - baseAlpha, 1 / t);
}

export function runA8Robustness(
  market: DiagnosticMarket,
  args: {
    realStatistic: number | null;
    scores: number[];
    outcomes: number[];
    statistic: (s: number[], o: number[]) => number | null;
    trialsConsidered: number;
    baseAlpha?: number;
    nDates: number;
    minDates: number;
  },
): DiagnosticFinding {
  const baseAlpha = args.baseAlpha ?? 0.05;
  const alpha = adjustedAlpha(baseAlpha, args.trialsConsidered);
  const placebo = args.realStatistic == null
    ? { pValue: 1, iterations: 0, placeboMean: null }
    : placeboPValue(args.realStatistic, args.scores, args.outcomes, args.statistic);

  const sample: DiagnosticSample = { nRows: args.scores.length, nDates: args.nDates, nSymbols: 0 };
  const gate = sampleStatus(sample, args.minDates);
  const survives = gate.ok && args.realStatistic != null && placebo.pValue <= alpha;

  return {
    market, testId: "A8", cohort: "learning",
    window: { from: "", to: "" },
    sample,
    coverage: 1,
    metricVersion: METRIC_VERSION,
    // `pass` here is the ONLY route to owner_review, and it requires clearing
    // the sample floor AND the trial-adjusted placebo hurdle.
    status: !gate.ok ? gate.status : survives ? "pass" : "fail",
    reason: !gate.ok
      ? gate.reason
      : survives
        ? `Survives the label-permutation placebo at the trial-adjusted alpha (p=${placebo.pValue.toFixed(4)} <= ${alpha.toFixed(4)} over ${args.trialsConsidered} trial(s)).`
        : `Does NOT survive: placebo p=${placebo.pValue.toFixed(4)} against a trial-adjusted alpha of ${alpha.toFixed(4)} over ${args.trialsConsidered} trial(s).`,
    metrics: {
      realStatistic: args.realStatistic,
      placeboPValue: placebo.pValue,
      placeboIterations: placebo.iterations,
      placeboMean: placebo.placeboMean,
      trialsConsidered: args.trialsConsidered,
      baseAlpha,
      adjustedAlpha: alpha,
    },
  };
}
