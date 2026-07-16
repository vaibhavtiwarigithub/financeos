// Per-symbol return-observation contract — the MEASUREMENT PREREQUISITE for
// correlation-aware construction (features/correlation-aware-construction/
// FEATURE_ARCHITECTURE.md §0, "Required prerequisite", item 1).
//
// WHY THIS EXISTS
// ---------------
// The original P0 assumed measured beta/correlation could be reused from Holding
// Risk. That was FALSE. Holding Risk computes pairwise correlation in memory among
// ALREADY-HELD names only, and persists per-name cluster summaries — not the pairwise
// matrix. A new candidate is never part of that run, so there is NO candidate-to-book
// correlation to consume at entry. The persisted per-holding `beta` is sector-proxy
// derived, not measured.
//
// This module builds the missing evidence contract so correlation can EVENTUALLY be
// measured. It does NOT activate anything.
//
// 🚨 BOUNDARY — MEASURE/CAPTURE ONLY
// Nothing here is read by lib/portfolio/constructor.ts, scoring, sizing, eligibility,
// order, or exit. The constructor stays on its current conservative volatility/
// sector-proxy behavior. Faking candidate correlations from held-name cluster
// averages is prohibited. The ONLY live-path change is a fire-and-forget capture hook
// in lib/research-agent.ts, piggybacked on candles that were ALREADY fetched for
// scoring — this module makes no provider call of its own.
//
// POINT-IN-TIME IS THE WHOLE POINT
// Every row carries `available_at`. A value must never be storable that we could not
// have known at that timestamp: bars dated after the capture instant are dropped
// before anything is computed from them. Beta is stored ONLY when genuinely
// measurable against the market's own benchmark (US vs SPY, India vs NIFTY) over at
// least MIN_BETA_OVERLAP shared sessions — `null` otherwise. A sector proxy is NEVER
// written into the beta column.
//
// The pure helpers below carry all the semantics and are unit-tested directly with no
// network and no live Supabase.

import type { Candle } from "@/lib/data/technicals";
import type { BenchmarkBar } from "@/lib/data/benchmark-series";
import { benchmarkFor } from "@/lib/data/benchmark-series";

export type Market = "us" | "india";

export const TABLE = "symbol_return_observations";

/** Minimum daily returns required before a volatility number is honest. */
export const MIN_VOL_OBSERVATIONS = 20;

/**
 * Minimum shared sessions with the benchmark before beta is considered measurable.
 * 60 mirrors the min-overlap the spec requires per correlation pair (§4.2) — we hold
 * beta to the same bar so a "measured" beta never rests on a thinner sample than a
 * "measured" correlation would.
 */
export const MIN_BETA_OVERLAP = 60;

/** Why beta could not be measured. Stored so the gap is auditable, never guessed around. */
export type BetaUnmeasurableReason =
  | "no_benchmark_for_market"
  | "benchmark_series_unavailable"
  | "insufficient_overlap"
  | "benchmark_zero_variance"
  | null;

export interface ReturnObservationRow {
  symbol: string;
  market: string;
  as_of: string; // last session date the observation reflects (YYYY-MM-DD)
  available_at: string; // ISO — when we could first have known this row
  source: string | null; // candle provider the bars came from
  window_start: string; // first session date in the return window
  window_end: string; // last session date in the return window (== as_of)
  observation_count: number; // daily returns used for vol
  daily_vol: number | null; // sample stddev of daily simple returns; null when thin
  benchmark_symbol: string | null;
  benchmark_beta: number | null; // ONLY when genuinely measurable; never a proxy
  benchmark_overlap_sessions: number; // shared return sessions with the benchmark
  beta_unmeasurable_reason: BetaUnmeasurableReason;
  input_fingerprint: string;
}

export interface BuildInput {
  symbol: string;
  market: Market;
  candles: Candle[];
  source?: string | null;
  benchmark?: BenchmarkBar[] | null;
  /** Injectable clock for deterministic tests. Defaults to now. */
  now?: Date;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** UTC calendar date of an instant, as YYYY-MM-DD. */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * POINT-IN-TIME FILTER — the load-bearing guard.
 * Drops any bar dated after `availableAt`'s UTC date, so nothing computed from this
 * series could depend on data that did not exist at `available_at`. Also drops
 * unusable closes and sorts oldest-first (providers disagree on order).
 */
export function pitFilter<T extends { date: string; close: number }>(bars: T[], availableAt: Date): T[] {
  const cutoff = utcDate(availableAt);
  return bars
    .filter((b) => b && typeof b.date === "string" && b.date.length >= 10)
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .filter((b) => b.date.slice(0, 10) <= cutoff)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface DailyReturn {
  date: string;
  ret: number;
}

/** Daily simple returns, dated by the LATER of each consecutive pair. */
export function dailyReturns(bars: { date: string; close: number }[]): DailyReturn[] {
  const out: DailyReturn[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    if (!Number.isFinite(prev) || prev <= 0) continue;
    const ret = bars[i].close / prev - 1;
    if (!Number.isFinite(ret)) continue;
    out.push({ date: bars[i].date, ret });
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample (n-1) standard deviation. Null below 2 points. */
export function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Number.isFinite(v) && v >= 0 ? Math.sqrt(v) : null;
}

/** Inner-join two return series on their session dates. */
export function alignReturns(a: DailyReturn[], b: DailyReturn[]): { a: number[]; b: number[]; dates: string[] } {
  const byDate = new Map(b.map((r) => [r.date, r.ret]));
  const outA: number[] = [];
  const outB: number[] = [];
  const dates: string[] = [];
  for (const r of a) {
    const m = byDate.get(r.date);
    if (m === undefined) continue;
    outA.push(r.ret);
    outB.push(m);
    dates.push(r.date);
  }
  return { a: outA, b: outB, dates };
}

export interface BetaResult {
  beta: number | null;
  overlap: number;
  reason: BetaUnmeasurableReason;
}

/**
 * OLS beta of symbol returns on benchmark returns: cov(s,b) / var(b).
 * Returns null — never a proxy, never a default of 1.0 — whenever the estimate
 * would not be genuinely measured.
 */
export function measureBeta(
  symbolReturns: DailyReturn[],
  benchmarkReturns: DailyReturn[],
  minOverlap = MIN_BETA_OVERLAP,
): BetaResult {
  const { a, b } = alignReturns(symbolReturns, benchmarkReturns);
  const n = a.length;
  if (n < minOverlap) return { beta: null, overlap: n, reason: "insufficient_overlap" };

  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let varb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    varb += (b[i] - mb) * (b[i] - mb);
  }
  if (!(varb > 0)) return { beta: null, overlap: n, reason: "benchmark_zero_variance" };
  const beta = cov / varb;
  if (!Number.isFinite(beta)) return { beta: null, overlap: n, reason: "benchmark_zero_variance" };
  return { beta: round(beta, 6), overlap: n, reason: null };
}

function round(x: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

/**
 * Deterministic fingerprint of the inputs an observation was computed from.
 * Stable across runs and independent of the wall clock: the same bars + benchmark +
 * source always fingerprint identically, so a re-run that learned nothing new dedups
 * instead of appending a redundant row. djb2 — dependency-free, matches the
 * lib/data/pit-fundamentals.ts convention.
 */
export function fingerprint(input: {
  symbol: string;
  market: string;
  source: string | null;
  benchmarkSymbol: string | null;
  bars: { date: string; close: number }[];
  benchmarkOverlap: number;
}): string {
  const series = input.bars.map((b) => `${b.date}:${round(b.close, 6)}`).join(",");
  const basis = [
    input.symbol,
    input.market,
    input.source ?? "",
    input.benchmarkSymbol ?? "",
    String(input.benchmarkOverlap),
    String(input.bars.length),
    series,
  ].join("|");
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
  // Second pass over the reversed basis widens the space enough that near-identical
  // long series don't collide on a single 32-bit djb2.
  let h2 = 52711;
  for (let i = basis.length - 1; i >= 0; i--) h2 = ((h2 << 5) + h2 + basis.charCodeAt(i)) | 0;
  return `f${(h >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

/**
 * Build one immutable return observation from candles that were ALREADY fetched.
 * Returns null when there is nothing honest to record (no usable bars, no returns).
 * Never throws.
 */
export function buildReturnObservation(input: BuildInput): ReturnObservationRow | null {
  const now = input.now ?? new Date();
  const availableAt = now;

  const bars = pitFilter(input.candles ?? [], availableAt);
  if (bars.length < 2) return null;

  const rets = dailyReturns(bars);
  if (rets.length < 1) return null;

  const vol = rets.length >= MIN_VOL_OBSERVATIONS ? stddev(rets.map((r) => r.ret)) : null;

  const benchmarkSymbol = benchmarkFor(input.market);
  let beta: BetaResult;
  if (!benchmarkSymbol) {
    beta = { beta: null, overlap: 0, reason: "no_benchmark_for_market" };
  } else {
    // The benchmark series gets the SAME point-in-time filter — an observation must
    // not borrow a benchmark bar it could not have seen either.
    const benchBars = pitFilter(input.benchmark ?? [], availableAt);
    if (benchBars.length < 2) {
      beta = { beta: null, overlap: 0, reason: "benchmark_series_unavailable" };
    } else {
      beta = measureBeta(rets, dailyReturns(benchBars), MIN_BETA_OVERLAP);
    }
  }

  const windowStart = bars[0].date;
  const windowEnd = bars[bars.length - 1].date;

  return {
    symbol: input.symbol,
    market: input.market,
    as_of: windowEnd,
    available_at: availableAt.toISOString(),
    source: input.source ?? null,
    window_start: windowStart,
    window_end: windowEnd,
    observation_count: rets.length,
    daily_vol: vol == null ? null : round(vol, 8),
    benchmark_symbol: benchmarkSymbol,
    benchmark_beta: beta.beta,
    benchmark_overlap_sessions: beta.overlap,
    beta_unmeasurable_reason: beta.reason,
    input_fingerprint: fingerprint({
      symbol: input.symbol,
      market: input.market,
      source: input.source ?? null,
      benchmarkSymbol,
      bars,
      benchmarkOverlap: beta.overlap,
    }),
  };
}

// ── DB-backed capture ────────────────────────────────────────────────────────

export interface ObsDbClient {
  from(table: string): {
    insert: (row: Record<string, unknown>) => Promise<{ error?: unknown }>;
  };
}

/**
 * Capture-on-fetch: append one return observation. Additive, NON-BLOCKING and
 * FAIL-OPEN on every path — a missing table or a failed write can never break
 * scoring. Called fire-and-forget (`void`) from lib/research-agent.ts on candles
 * that were already in hand; costs no provider call and nothing awaits it.
 *
 * Duplicate fingerprints are rejected by the table's unique index; that conflict is
 * swallowed here (a re-run that learned nothing new should append nothing).
 */
export async function captureReturnObservation(
  supabase: ObsDbClient,
  input: BuildInput,
): Promise<ReturnObservationRow | null> {
  try {
    const row = buildReturnObservation(input);
    if (!row) return null;
    const res = await supabase.from(TABLE).insert(row as unknown as Record<string, unknown>);
    if (res?.error) return null;
    return row;
  } catch {
    return null; // fail-open: research must survive any capture error
  }
}
