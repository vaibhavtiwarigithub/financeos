// Shared, run-level benchmark close series (US → SPY, India → ^NSEI).
//
// WHY THIS EXISTS: two consumers need the market benchmark's daily closes during a
// research run — the regime features (lib/validation/regime.ts) and the per-symbol
// return-observation capture (lib/data/return-observations.ts). Before this module,
// regime features fetched the series inline; a second inline fetch for observations
// would have been a NEW provider call per run, which the return-observation contract
// explicitly forbids.
//
// So both consumers now share ONE cache:
//   - US: read from `price_cache` (a DB read — no provider call at all).
//   - India: `fetchYahooCandles("^NSEI")` — the SAME single call the regime path
//     already made. It is not an additional call; it is the existing one, hoisted.
//
// The cache stores the in-flight PROMISE (not the resolved value) so two concurrent
// callers — the fire-and-forget observation capture and the awaited regime read —
// collapse into a single fetch rather than racing into two.

import { fetchYahooCandles } from "@/lib/india-data";
import { assessSeries } from "@/lib/data/price-cache-freshness";

export interface BenchmarkBar {
  date: string; // YYYY-MM-DD
  close: number;
}

/**
 * W9 — the series plus WHEN it ends and whether that is current.
 *
 * The US benchmark comes out of `price_cache`, which froze for 101 of 140 symbols
 * on 2026-07-22. SPY happened to keep filling, so beta and RS kept working — but
 * nothing in this module would have noticed if it had not. A frozen SPY series
 * produces a beta that looks like a measurement and is actually a fossil.
 *
 * So the series no longer travels as a bare array. `stale` is a first-class part
 * of the answer, and `getBenchmarkSeries` resolves to `[]` when it is set —
 * downstream already reads `[]` as "beta unmeasurable", which is the honest
 * reading of a stale benchmark and is why no caller needed changing.
 */
export interface BenchmarkSeries {
  bars: BenchmarkBar[];
  /** Market date of the newest close, or null when there is none. */
  asOf: string | null;
  stale: boolean;
  reason: "ok" | "no_data" | "insufficient_coverage" | "stale_series";
}

/** Enough closes to be a benchmark at all; below this beta/RS are not meaningful. */
const MIN_BENCHMARK_BARS = 30;

/** The benchmark each market's beta is measured against. Never cross-market. */
export const BENCHMARK_BY_MARKET: Record<string, string> = {
  us: "SPY",
  india: "^NSEI",
};

export function benchmarkFor(market: string): string | null {
  return BENCHMARK_BY_MARKET[market] ?? null;
}

const TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; series: Promise<BenchmarkSeries> }>();

/** Test-only: drop the run-level cache so a test can control what is returned. */
export function __resetBenchmarkCache(): void {
  cache.clear();
}

async function loadUsBenchmark(supabase: any): Promise<BenchmarkSeries> {
  // price_cache is filled by the daily kairos-price-cache-fill job. Reading it is a
  // DB read, not a provider call. limit 260 mirrors the pre-existing regime read so
  // regime features stay byte-identical.
  const { data } = await supabase
    .from("price_cache")
    .select("date, close")
    .eq("symbol", BENCHMARK_BY_MARKET.us)
    .order("date", { ascending: true })
    .limit(260);
  const bars = (data ?? [])
    .map((r: any) => ({ date: String(r.date), close: parseFloat(r.close) }))
    .filter((b: BenchmarkBar) => Number.isFinite(b.close) && b.close > 0);

  // Same rule as every other price_cache consumer: the BAR'S market date decides,
  // not when the row was written. Delegated so there is one rule, not four.
  const verdict = assessSeries(bars, {
    symbol: BENCHMARK_BY_MARKET.us,
    market: "us",
    minBars: MIN_BENCHMARK_BARS,
  });
  return { bars, asOf: verdict.asOf, stale: !verdict.ok, reason: verdict.reason };
}

async function loadIndiaBenchmark(): Promise<BenchmarkSeries> {
  // "2y", not "1y". computeTechnicals only computes RS when the benchmark series
  // has >= 252 closes, but NSE trades ~246 days a year (more holidays than NYSE),
  // so a 1-year ^NSEI range returned 246 usable closes and India's rs_vs_benchmark
  // was NEVER computed — silently null on every India row, while US passed via
  // price_cache's limit(260). The RS window itself is still bounded by the symbol's
  // own candle count (min(candles, bench, 252)), so a longer benchmark range only
  // satisfies the availability gate; it does not widen the measured window or
  // change the US path.
  const candles = await fetchYahooCandles(BENCHMARK_BY_MARKET.india, "2y");
  const bars = candles
    .map((c) => ({ date: c.date, close: c.close }))
    .filter((b) => Number.isFinite(b.close) && b.close > 0);
  // India is fetched live from Yahoo per run, never from price_cache — it cannot
  // freeze the way the US path can. asOf is still reported so both markets answer
  // the same question; staleness is left to the provider.
  const asOf = bars.length ? bars.reduce((m, b) => (b.date > m ? b.date : m), bars[0].date) : null;
  return { bars, asOf, stale: false, reason: bars.length ? "ok" : "no_data" };
}

const EMPTY: BenchmarkSeries = { bars: [], asOf: null, stale: true, reason: "no_data" };

/**
 * Benchmark closes for a market WITH freshness, oldest-first. Cached per process
 * for 30 minutes and deduped while in flight. Never throws.
 */
export async function getBenchmarkSeriesStatus(market: string, supabase: any): Promise<BenchmarkSeries> {
  const hit = cache.get(market);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.series;

  const series = (market === "india" ? loadIndiaBenchmark() : loadUsBenchmark(supabase)).catch(() => EMPTY);
  cache.set(market, { at: Date.now(), series });
  return series;
}

/**
 * Benchmark daily closes for a market, oldest-first.
 *
 * Resolves to [] on any error AND on a stale or under-covered series. Downstream
 * reads [] as "beta unmeasurable" rather than as a fabricated value — which is
 * exactly the right reading of a frozen benchmark, and is why the freshness gate
 * lives here rather than being pushed onto every caller.
 */
export async function getBenchmarkSeries(market: string, supabase: any): Promise<BenchmarkBar[]> {
  const status = await getBenchmarkSeriesStatus(market, supabase);
  if (status.stale) {
    console.warn(
      `[benchmark-series] ${market}: series unusable — ${status.reason} (asOf=${status.asOf ?? "none"}, bars=${status.bars.length}). Beta/RS will be null.`,
    );
    return [];
  }
  return status.bars;
}
