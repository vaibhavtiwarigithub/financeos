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
//   - India: `fetchIndiaCandles("^NSEI")` — the SAME single call the regime path
//     already made. It is not an additional call; it is the existing one, hoisted.
//
// The cache stores the in-flight PROMISE (not the resolved value) so two concurrent
// callers — the fire-and-forget observation capture and the awaited regime read —
// collapse into a single fetch rather than racing into two.

import { fetchIndiaCandles } from "@/lib/india-data";

export interface BenchmarkBar {
  date: string; // YYYY-MM-DD
  close: number;
}

/** The benchmark each market's beta is measured against. Never cross-market. */
export const BENCHMARK_BY_MARKET: Record<string, string> = {
  us: "SPY",
  india: "^NSEI",
};

export function benchmarkFor(market: string): string | null {
  return BENCHMARK_BY_MARKET[market] ?? null;
}

const TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; series: Promise<BenchmarkBar[]> }>();

/** Test-only: drop the run-level cache so a test can control what is returned. */
export function __resetBenchmarkCache(): void {
  cache.clear();
}

async function loadUsBenchmark(supabase: any): Promise<BenchmarkBar[]> {
  // price_cache is filled by the daily kairos-price-cache-fill job. Reading it is a
  // DB read, not a provider call. limit 260 mirrors the pre-existing regime read so
  // regime features stay byte-identical.
  const { data } = await supabase
    .from("price_cache")
    .select("date, close")
    .eq("symbol", BENCHMARK_BY_MARKET.us)
    .order("date", { ascending: true })
    .limit(260);
  return (data ?? [])
    .map((r: any) => ({ date: String(r.date), close: parseFloat(r.close) }))
    .filter((b: BenchmarkBar) => Number.isFinite(b.close) && b.close > 0);
}

async function loadIndiaBenchmark(): Promise<BenchmarkBar[]> {
  const candles = await fetchIndiaCandles(BENCHMARK_BY_MARKET.india, "1y");
  return candles
    .map((c) => ({ date: c.date, close: c.close }))
    .filter((b) => Number.isFinite(b.close) && b.close > 0);
}

/**
 * Benchmark daily closes for a market, oldest-first. Cached per process for 30
 * minutes and deduped while in flight. Never throws — resolves to [] on any error,
 * which downstream reads as "beta unmeasurable" rather than as a fabricated value.
 */
export async function getBenchmarkSeries(market: string, supabase: any): Promise<BenchmarkBar[]> {
  const hit = cache.get(market);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.series;

  const series = (market === "india" ? loadIndiaBenchmark() : loadUsBenchmark(supabase)).catch(
    () => [] as BenchmarkBar[],
  );
  cache.set(market, { at: Date.now(), series });
  return series;
}
