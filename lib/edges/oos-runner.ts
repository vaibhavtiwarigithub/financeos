// Out-of-sample IC runner — features/walk-forward-ic-folds step 7.
//
// Turns a fold plan into the per-as-of-date IC series that aggregateOosIc()
// consumes. Its FIRST deliverable is the realized sigma of that series, because
// Annex F makes every approved sample floor conditional on it: at sigma 0.071
// the floors need ~13 as-of dates, at 0.10 exactly the ~25 available, and at the
// legacy measured 0.438 they would need ~480. Report sigma before treating any
// t-stat as meaningful.
//
// Ordering discipline, which is the whole point of the exercise:
//   feature  uses candles <= asOf                  (sliceAsOf)
//   label    uses candles from asOf to asOf + H     (forwardReturn)
//   universe is the PIT membership resolved AT asOf (never today's survivors)
// A label that has not fully matured by the data cutoff is dropped, never
// truncated to whatever price happens to be available.

import { spearman } from "@/lib/edges/ic";
import { sliceAsOf } from "@/lib/edges/data";
import { crossSectionalZ } from "@/lib/edges/standardize";
import { aggregateOosIc, type Fold, type OosIcAggregate } from "@/lib/edges/folds";
import type { Candle } from "@/lib/data/technicals";
import type { EdgeDef, Market } from "@/lib/edges/types";

export interface SymbolSeries {
  symbol: string;
  candles: Candle[]; // ascending, full span
}

/**
 * Realized forward return from the session at `asOf` to `horizonSessions` later.
 *
 * Returns null when the label has not fully matured — a partially matured label
 * is a different (shorter) horizon wearing the same name, and averaging the two
 * silently changes what the IC measures.
 */
export function forwardReturn(candles: Candle[], asOf: string, horizonSessions: number): number | null {
  const i = candles.findIndex((c) => c.date === asOf);
  if (i < 0) return null;
  const j = i + horizonSessions;
  if (j >= candles.length) return null; // label not matured by the data cutoff
  const p0 = candles[i].close, p1 = candles[j].close;
  if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0) return null;
  return p1 / p0 - 1;
}

export interface DateIcInput {
  asOf: string;
  /** PIT membership for THIS date — not the union, not today's list. */
  universe: string[];
  series: Map<string, Candle[]>;
  benchmark: Candle[];
  edge: EdgeDef;
  market: Market;
  horizonSessions: number;
  minCrossSection: number;
}

export type DateIcResult =
  | { ok: true; asOf: string; ic: number; crossSection: number }
  | { ok: false; asOf: string; reason: string; crossSection: number };

/**
 * Cross-sectional rank IC for one as-of date. Pure given its inputs.
 *
 * A sparse date is EXCLUDED and counted, never coerced to IC = 0 — a zero is an
 * observation of no predictive power, which is a different claim from having
 * too few names to measure.
 */
export function computeDateIc(input: DateIcInput): DateIcResult {
  const { asOf, universe, series, benchmark, edge, market, horizonSessions, minCrossSection } = input;
  const bench = sliceAsOf(benchmark, asOf);

  const raw: number[] = [];
  const fwd: number[] = [];
  for (const symbol of universe) {
    const full = series.get(symbol);
    if (!full) continue;
    const candles = sliceAsOf(full, asOf);
    if (candles.length < edge.minCandles) continue;
    // The feature sees only <= asOf; the label is computed on the FULL series.
    const value = edge.compute({ symbol, market, asOf, candles, benchmark: bench });
    if (value == null || !Number.isFinite(value)) continue;
    const ret = forwardReturn(full, asOf, horizonSessions);
    if (ret == null) continue;
    raw.push(value);
    fwd.push(ret);
  }

  if (raw.length < minCrossSection) {
    return { ok: false, asOf, reason: "cross_section_below_min", crossSection: raw.length };
  }

  // Winsorize + z-score across the cross-section, matching the standard IC path.
  // Rank correlation is invariant to this, but it keeps one pipeline shape and
  // drops the same outliers the production path drops.
  const z = crossSectionalZ(raw);
  const pairs = z
    .map((v, i) => ({ v, r: fwd[i] }))
    .filter((p): p is { v: number; r: number } => p.v != null && Number.isFinite(p.r));
  if (pairs.length < minCrossSection) {
    return { ok: false, asOf, reason: "cross_section_below_min", crossSection: pairs.length };
  }

  const ic = spearman(pairs.map((p) => p.v), pairs.map((p) => p.r));
  if (!Number.isFinite(ic)) {
    return { ok: false, asOf, reason: "ic_not_finite", crossSection: pairs.length };
  }
  return { ok: true, asOf, ic, crossSection: pairs.length };
}

export interface OosRunReport {
  edgeId: string;
  market: Market;
  horizonSessions: number;
  stepSessions: number;
  foldCount: number;
  datesEvaluated: number;
  /** Full audit series: enough to recompute aggregate mean/sigma/HAC externally. */
  perDate: Array<{ date: string; ic: number; foldIndex: number }>;
  datesSkipped: Array<{ asOf: string; reason: string; crossSection: number }>;
  aggregate: OosIcAggregate | null;
  /** Plain-language verdict on the Annex F stop condition. */
  sigmaVerdict: string;
}

/**
 * Run the fold plan over pre-fetched series and produce the report.
 *
 * Candles are fetched ONCE per symbol for the whole span by the caller and
 * sliced per date here — fetching per (symbol, date) would be ~24x the calls for
 * identical data.
 */
export function runOosFolds(opts: {
  folds: Fold[];
  universeByDate: Map<string, string[]>;
  series: Map<string, Candle[]>;
  benchmark: Candle[];
  edge: EdgeDef;
  market: Market;
  horizonSessions: number;
  stepSessions: number;
  minCrossSection: number;
}): OosRunReport {
  const { folds, universeByDate, series, benchmark, edge, market, horizonSessions, stepSessions, minCrossSection } = opts;

  const perDate: Array<{ date: string; ic: number; foldIndex: number }> = [];
  const skipped: OosRunReport["datesSkipped"] = [];

  for (const fold of folds) {
    for (const asOf of fold.asOfDates) {
      const universe = universeByDate.get(asOf);
      if (!universe || !universe.length) {
        skipped.push({ asOf, reason: "universe_unavailable", crossSection: 0 });
        continue;
      }
      const r = computeDateIc({
        asOf, universe, series, benchmark, edge, market, horizonSessions, minCrossSection,
      });
      if (r.ok) {
        // Normalize every edge so positive IC always means "the edge worked".
        // The standard IC path already does this; omitting it here inverted
        // low-volatility and every future expectedSign=-1 edge.
        perDate.push({
          date: r.asOf,
          ic: edge.expectedSign < 0 ? -r.ic : r.ic,
          foldIndex: fold.index,
        });
      }
      else skipped.push({ asOf: r.asOf, reason: r.reason, crossSection: r.crossSection });
    }
  }

  const aggregate = aggregateOosIc(perDate, horizonSessions, stepSessions);
  return {
    edgeId: edge.id,
    market,
    horizonSessions,
    stepSessions,
    foldCount: folds.length,
    datesEvaluated: perDate.length,
    perDate,
    datesSkipped: skipped,
    aggregate,
    sigmaVerdict: describeSigma(aggregate),
  };
}

/** Annex F stop condition, stated so a reader cannot miss it. */
export function describeSigma(a: OosIcAggregate | null): string {
  if (!a) return "No aggregate - too few evaluated dates to measure sigma.";
  if (a.sigmaWithinPlan) {
    return (
      `PRELIMINARY: sample sigma=${a.sigmaIc.toFixed(4)} is within the 0.10 planning ` +
      `ceiling on n=${a.n} dates. This point estimate supports the planning assumption ` +
      `but does not by itself validate a floor or make t_HAC=${a.tHac.toFixed(2)} promotion evidence.`
    );
  }
  const needed = Math.ceil((2 * a.sigmaIc / 0.04) ** 2);
  return (
    `PRELIMINARY STOP: sample sigma=${a.sigmaIc.toFixed(4)} exceeds the 0.10 planning ` +
    `ceiling on n=${a.n} dates. Conditional on this point estimate, detecting a 0.04 IC ` +
    `at t=2.0 would need ~${needed} as-of dates. Do not treat the ceiling comparison or ` +
    `t_HAC=${a.tHac.toFixed(2)} as promotion evidence until a fully PIT, auditable run ` +
    `with an adequate sample confirms it.`
  );
}
