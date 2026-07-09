// Edge/Factor Discovery P0 — bounded candle resolver. MEASURE-ONLY.
// Reuses the EXISTING provider-cached + budgeted candle fetchers (no new provider
// sweeps): US via Massive→EODHD→TwelveData (each day-cached under its own budget),
// India via Yahoo .NS. Returns partial results (empty candles) instead of retrying
// indefinitely, and reports the source so the job can surface provider usage.
import { fetchMassiveCandles, fetchEodhdCandles, fetchTwelveDataCandles } from "@/lib/data/candles";
import { fetchIndiaCandles } from "@/lib/india-data";
import type { Candle } from "@/lib/data/technicals";
import type { Market } from "@/lib/edges/types";

// ~420 calendar days ≈ 290 trading days — enough for 12-1 momentum (252+21) + buffer.
const US_DAYS = 420;

export interface CandleResult { candles: Candle[]; source: string }

export async function resolveCandles(symbol: string, market: Market): Promise<CandleResult> {
  if (market === "india") {
    const c = await fetchIndiaCandles(symbol, "2y").catch(() => [] as Candle[]);
    return { candles: c, source: c.length ? "yahoo_india" : "unavailable" };
  }
  let c = await fetchMassiveCandles(symbol, US_DAYS).catch(() => [] as Candle[]);
  if (c.length) return { candles: c, source: "massive" };
  c = await fetchEodhdCandles(symbol, US_DAYS).catch(() => [] as Candle[]);
  if (c.length) return { candles: c, source: "eodhd" };
  c = await fetchTwelveDataCandles(symbol, US_DAYS).catch(() => [] as Candle[]);
  return { candles: c, source: c.length ? "twelvedata" : "unavailable" };
}

// Broad-market benchmark per market (for relative-strength). SPY for US, NIFTY 50
// (^NSEI) for India. Resolved ONCE per run, not per symbol.
export async function resolveBenchmark(market: Market): Promise<CandleResult> {
  if (market === "india") {
    const c = await fetchIndiaCandles("^NSEI", "2y").catch(() => [] as Candle[]);
    return { candles: c, source: c.length ? "yahoo_india" : "unavailable" };
  }
  return resolveCandles("SPY", "us");
}

// Slice a candle series to those dated <= asOf (no look-ahead). Assumes ascending.
export function sliceAsOf(candles: Candle[], asOf: string): Candle[] {
  return candles.filter(c => c.date <= asOf);
}
