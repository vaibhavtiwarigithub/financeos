import { computeSpearmanIC } from "@/lib/validation/feature-check";

/**
 * Quantile and stability diagnostics for a scoring dimension.
 * features/factor-quantile-diagnostics/FEATURE_ARCHITECTURE.md
 *
 * Method ported from alphalens (`mean_return_by_quantile`,
 * `compute_mean_returns_spread`, `factor_rank_autocorrelation`); no dependency
 * is added — alphalens is Python and the money path is TypeScript.
 *
 * WHY, GIVEN WE ALREADY HAVE RANK IC. Rank IC answers "does the ordering
 * correlate with returns?". It cannot answer "is the ordering MONOTONIC, and is
 * the top-minus-bottom spread worth trading?" — and a small positive IC is
 * equally consistent with a clean gradient (tradeable) and a flat middle with
 * one extreme tail dragging the correlation (an artifact). Measured 2026-09-02,
 * sentiment at +0.0886 and technical at -0.1325 are indistinguishable between
 * those two worlds.
 *
 * MEASURE-ONLY. Nothing here reaches a score, size, entry, exit or order.
 */

export interface FactorRow {
  symbol: string;
  value: number;
  outcome: number;
  /** ISO timestamp; the session is its date prefix. */
  ts: string;
}

export const DEFAULT_QUANTILES = 5;
/** A quintile built from one name is not a quintile. */
export const MIN_PER_BUCKET = 3;
/** Consecutive sessions must share this many symbols to compare their rankings. */
export const MIN_AUTOCORR_OVERLAP = 5;

export interface QuantileDiagnostics {
  quantiles: number;
  /** Sessions that met the per-bucket and distinct-value guards. */
  qualifying_sessions: number;
  /** Sessions dropped for thin buckets or too few distinct values — reported, never folded in. */
  excluded_sessions: number;
  /** Mean forward return per bucket, lowest score first. */
  mean_return_by_quantile: Array<number | null>;
  /**
   * Spearman correlation between bucket index and bucket mean return: +1 is a
   * perfectly monotonic gradient, 0 is no gradient, -1 is perfectly inverted.
   * Reported instead of a boolean because "monotonic or not" throws away how
   * badly it fails.
   */
  monotonicity: number | null;
  /** Mean per-session (top bucket - bottom bucket) return. */
  spread_top_minus_bottom: number | null;
  spread_std_error: number | null;
  /** spread / stdError, using nEffective — never the raw session count. */
  spread_t: number | null;
  /**
   * Mean Spearman correlation between a dimension's cross-sectional ranks on
   * CONSECUTIVE sessions. Separates two failure modes that look identical in an
   * IC table: a stable but inverted signal (high autocorrelation, negative IC —
   * flip or drop it) from a ranking that is day-to-day noise (autocorrelation
   * near zero — a data problem, not an alpha problem).
   *
   * Null for a dimension with no cross-sectional variance at all, which is the
   * same fact that makes `macro`'s IC exactly 0.0000 by construction.
   */
  rank_autocorrelation: number | null;
  autocorrelation_pairs: number;
}

function sessionOf(ts: string): string {
  return ts.slice(0, 10);
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Assign each row to a bucket by its rank within the session.
 *
 * Position-based split after an ascending sort, which is what makes the buckets
 * equal-sized. Ties therefore land in whichever bucket their sort position
 * falls in — acceptable for a continuous score, and guarded separately: a
 * session with fewer distinct values than buckets is EXCLUDED rather than
 * bucketed, because a dimension that is constant (or near-constant) across the
 * cross-section has no quantiles to speak of.
 */
export function assignBuckets<T>(rows: T[], value: (row: T) => number, buckets: number): T[][] {
  const sorted = [...rows].sort((a, b) => value(a) - value(b));
  const out: T[][] = Array.from({ length: buckets }, () => []);
  for (let i = 0; i < sorted.length; i++) {
    const bucket = Math.min(buckets - 1, Math.floor((i * buckets) / sorted.length));
    out[bucket].push(sorted[i]);
  }
  return out;
}

export function quantileDiagnostics(
  rows: FactorRow[],
  opts: { quantiles?: number; nEffective?: number } = {},
): QuantileDiagnostics {
  const buckets = opts.quantiles ?? DEFAULT_QUANTILES;

  const bySession = new Map<string, FactorRow[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.value) || !Number.isFinite(row.outcome)) continue;
    const key = sessionOf(row.ts);
    const list = bySession.get(key) ?? [];
    list.push(row);
    bySession.set(key, list);
  }

  const bucketReturns: number[][] = Array.from({ length: buckets }, () => []);
  const spreads: number[] = [];
  let qualifying = 0;
  let excluded = 0;
  const orderedSessions: Array<{ date: string; rows: FactorRow[] }> = [];

  for (const [date, sessionRows] of [...bySession.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    orderedSessions.push({ date, rows: sessionRows });

    const distinct = new Set(sessionRows.map((r) => r.value)).size;
    // A constant or near-constant dimension has no cross-section to split.
    if (distinct < buckets || sessionRows.length < buckets * MIN_PER_BUCKET) {
      excluded++;
      continue;
    }
    const split = assignBuckets(sessionRows, (r) => r.value, buckets);
    if (split.some((b) => b.length < MIN_PER_BUCKET)) {
      excluded++;
      continue;
    }
    const means = split.map((b) => mean(b.map((r) => r.outcome))!);
    for (let i = 0; i < buckets; i++) bucketReturns[i].push(means[i]);
    spreads.push(means[buckets - 1] - means[0]);
    qualifying++;
  }

  const meanByQuantile = bucketReturns.map((values) => mean(values));

  // Monotonicity: is bucket index related to bucket return, and how strongly?
  let monotonicity: number | null = null;
  const usable = meanByQuantile.filter((v): v is number => v != null);
  if (usable.length === buckets && buckets >= 5) {
    const result = computeSpearmanIC(meanByQuantile.map((_, i) => i), usable);
    monotonicity = result ? result.ic : null;
  }

  const spreadMean = mean(spreads);
  const spreadSd = sampleStdDev(spreads);
  // nEffective, NEVER the session count: consecutive forward windows overlap, so
  // dividing by sqrt(sessions) would overstate significance by sqrt(horizon) —
  // the same correction the IC path already applies.
  const nEff = opts.nEffective;
  const spreadSe = spreadSd != null && nEff != null && nEff > 0 ? spreadSd / Math.sqrt(nEff) : null;
  // A `> 0` guard is NOT enough. An identical spread every session gives a sample
  // sd of floating-point dust (measured: 1.16e-18, not exactly 0), which passes
  // `> 0` and yields a t of ~1e15 — dust rendering as an overwhelmingly decisive
  // result. Compare against the scale of the quantity instead of against zero.
  const spreadDegenerate =
    spreadSe == null || !Number.isFinite(spreadSe) ||
    spreadSe <= 1e-12 * Math.max(1, Math.abs(spreadMean ?? 0));
  const spreadT = spreadMean != null && !spreadDegenerate ? spreadMean / spreadSe! : null;

  // Rank autocorrelation across consecutive sessions, on their shared symbols.
  const autocorrs: number[] = [];
  for (let i = 1; i < orderedSessions.length; i++) {
    const prev = new Map(orderedSessions[i - 1].rows.map((r) => [r.symbol, r.value]));
    const shared: Array<[number, number]> = [];
    for (const row of orderedSessions[i].rows) {
      const before = prev.get(row.symbol);
      if (before != null) shared.push([before, row.value]);
    }
    if (shared.length < MIN_AUTOCORR_OVERLAP) continue;
    const result = computeSpearmanIC(shared.map((s) => s[0]), shared.map((s) => s[1]));
    // A constant dimension yields denom 0 -> ic 0 from computeSpearmanIC. That is
    // not "uncorrelated ranks", it is "no ranks at all", so it must not be
    // averaged in as if it were a measurement.
    if (!result) continue;
    const priorDistinct = new Set(shared.map((s) => s[0])).size;
    const nowDistinct = new Set(shared.map((s) => s[1])).size;
    if (priorDistinct < 2 || nowDistinct < 2) continue;
    autocorrs.push(result.ic);
  }

  return {
    quantiles: buckets,
    qualifying_sessions: qualifying,
    excluded_sessions: excluded,
    mean_return_by_quantile: meanByQuantile,
    monotonicity,
    spread_top_minus_bottom: spreadMean,
    spread_std_error: spreadSe,
    spread_t: spreadT,
    rank_autocorrelation: mean(autocorrs),
    autocorrelation_pairs: autocorrs.length,
  };
}
