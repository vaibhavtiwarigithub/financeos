// ATR-scaled exit stop — single-arm shadow. MEASURE-ONLY.
//
// Tests ONE predeclared, directional hypothesis:
//
//   H1: replacing the fixed 7.5% stop with a 2.8x ATR stop reduces premature
//       stop-outs and raises mean benchmark-neutral return, with the target and
//       the time stop left unchanged.
//
// The target is deliberately IDENTICAL in both arms (the live +19.2%), so the
// stop is the only term that varies and any difference is attributable to it.
// That is the whole design: `docs/audits/2026-09-01-exit-geometry-diagnosis.md`
// showed the winning grid arm gained entirely through stopping out 131 times
// instead of 185, with timeouts unchanged — not through hitting targets.
//
// Nothing here reads or writes a money path. Barrier resolution is delegated to
// lib/trading/exit-geometry-shadow.ts rather than reimplemented.

import { classifyExit, type Geometry, type LabelPoint } from "./exit-geometry-shadow";
import { effectiveObservations, MIN_EFFECTIVE_OBSERVATIONS } from "@/lib/learning/dimension-diagnostics";

/** The live configuration, exactly as deployed. */
export const BASELINE_STOP_GEOMETRY: Geometry = { stopPct: 0.075, targetPct: 0.192 };

/** ATR stop, LIVE target. Mixed by design — the stop is the only difference. */
export const CANDIDATE_STOP_GEOMETRY: Geometry = { stopAtr: 2.8, targetPct: 0.192 };

/**
 * Arms in the grid this hypothesis was SELECTED from.
 *
 * H1 did not arrive from theory; it won a 14-arm search. Reporting a nominal
 * p-value against 0.05 would therefore overstate it by roughly an order of
 * magnitude, so the threshold is Sidak-adjusted for the full family:
 *
 *   alpha_adj = 1 - (1 - 0.05)^(1/14) = 0.003657...
 *
 * Stored on every row so a later reader cannot mistake the nominal threshold for
 * the adjusted one.
 */
export const TRIALS_CONSIDERED = 14;
export const FAMILY_ALPHA = 0.05;
export function sidakAlpha(trials: number, familyAlpha = FAMILY_ALPHA): number {
  if (!Number.isFinite(trials) || trials < 1) return familyAlpha;
  return 1 - Math.pow(1 - familyAlpha, 1 / trials);
}

/** Two-sided critical |t| at the Sidak-adjusted alpha, normal approximation. */
export function criticalT(alpha: number): number {
  // Inverse normal CDF (Acklam), adequate for a threshold we only compare against.
  const p = 1 - alpha / 2;
  if (!(p > 0 && p < 1)) return Number.POSITIVE_INFINITY;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface StopShadowPoint extends LabelPoint {
  date: string;
  symbol: string;
}

export interface StopShadowResult {
  market: string;
  horizonDays: number;
  nRows: number;
  nDates: number;
  nSymbols: number;
  effectiveObservations: number;
  atrCoverage: number | null;
  baselineStops: number;
  candidateStops: number;
  baselineTimeouts: number;
  candidateTimeouts: number;
  baselineTargets: number;
  candidateTargets: number;
  /** Pairs discarded because EITHER arm was unresolvable. */
  pairsDropped: number;
  ambiguousShare: number | null;
  baselineMeanReturn: number | null;
  candidateMeanReturn: number | null;
  meanPairedDiff: number | null;
  pairedDiffT: number | null;
  candidateWorstReturn: number | null;
  baselineWorstReturn: number | null;
  trialsConsidered: number;
  sidakAlpha: number;
  status: "insufficient_evidence" | "measured";
  reason: string;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

/**
 * Paired, date-clustered comparison.
 *
 * PAIRING: a decision contributes only when BOTH arms resolve. Dropping the pair
 * — rather than the arm — is what keeps the comparison paired; letting one arm
 * keep a decision the other cannot classify would compare two different cohorts,
 * which is the error that invalidated an earlier sizing diagnosis on this book.
 *
 * CLUSTERING: the statistic is the mean over DATES, not over rows. Symbols
 * within one session share the market move and are not independent draws.
 */
export function runStopShadow(
  market: string,
  horizonDays: number,
  points: readonly StopShadowPoint[],
): StopShadowResult {
  const byDate = new Map<string, number[]>();
  const baseRets: number[] = [];
  const candRets: number[] = [];
  let baselineStops = 0, candidateStops = 0;
  let baselineTimeouts = 0, candidateTimeouts = 0;
  let baselineTargets = 0, candidateTargets = 0;
  let pairsDropped = 0;
  const symbols = new Set<string>();
  let withAtr = 0;

  for (const p of points) {
    if (p.atrPct > 0) withAtr++;
    const b = classifyExit(p, BASELINE_STOP_GEOMETRY);
    const c = classifyExit(p, CANDIDATE_STOP_GEOMETRY);
    if (b.ret == null || c.ret == null) { pairsDropped++; continue; }

    if (b.outcome === "stop") baselineStops++;
    else if (b.outcome === "timeout") baselineTimeouts++;
    else if (b.outcome === "target") baselineTargets++;
    if (c.outcome === "stop") candidateStops++;
    else if (c.outcome === "timeout") candidateTimeouts++;
    else if (c.outcome === "target") candidateTargets++;

    baseRets.push(b.ret);
    candRets.push(c.ret);
    symbols.add(p.symbol);
    const diffs = byDate.get(p.date) ?? [];
    diffs.push(c.ret - b.ret);
    byDate.set(p.date, diffs);
  }

  // One observation per date: the within-date mean difference.
  const dateDiffs = [...byDate.values()].map((ds) => ds.reduce((s, v) => s + v, 0) / ds.length);
  const nDates = dateDiffs.length;
  const nEff = effectiveObservations(nDates, horizonDays);
  const alpha = sidakAlpha(TRIALS_CONSIDERED);

  const meanDiff = mean(dateDiffs);
  let t: number | null = null;
  if (meanDiff != null && nDates >= 2) {
    const variance = dateDiffs.reduce((s, v) => s + (v - meanDiff) ** 2, 0) / (nDates - 1);
    const se = Math.sqrt(variance / nDates);
    t = se > 0 ? meanDiff / se : null;
  }

  const attempted = points.length;
  const ambiguousShare = attempted ? pairsDropped / attempted : null;
  const insufficient = nEff < MIN_EFFECTIVE_OBSERVATIONS;

  return {
    market, horizonDays,
    nRows: baseRets.length, nDates, nSymbols: symbols.size,
    effectiveObservations: nEff,
    atrCoverage: attempted ? withAtr / attempted : null,
    baselineStops, candidateStops,
    baselineTimeouts, candidateTimeouts,
    baselineTargets, candidateTargets,
    pairsDropped, ambiguousShare,
    baselineMeanReturn: mean(baseRets),
    candidateMeanReturn: mean(candRets),
    meanPairedDiff: meanDiff,
    pairedDiffT: t,
    candidateWorstReturn: candRets.length ? Math.min(...candRets) : null,
    baselineWorstReturn: baseRets.length ? Math.min(...baseRets) : null,
    trialsConsidered: TRIALS_CONSIDERED,
    sidakAlpha: alpha,
    status: insufficient ? "insufficient_evidence" : "measured",
    reason: insufficient
      ? `${nDates} date(s) at a ${horizonDays}-day horizon overlap to ${nEff.toFixed(2)} independent observations (need ${MIN_EFFECTIVE_OBSERVATIONS}). No weighting or exit conclusion is permitted.`
      : `Paired date-clustered difference over ${nDates} dates. Significance requires |t| >= ${criticalT(alpha).toFixed(3)} at the Sidak-adjusted alpha ${alpha.toFixed(5)} for ${TRIALS_CONSIDERED} trials. Descriptive until a forward shadow confirms it.`,
  };
}
