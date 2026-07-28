// Edge/Factor Discovery P0 — bounded candle resolver. MEASURE-ONLY.
// Reuses the EXISTING provider-cached + budgeted candle fetchers (no new provider
// sweeps): US via Massive→EODHD→TwelveData (each day-cached under its own budget),
// India via Yahoo .NS. Returns partial results (empty candles) instead of retrying
// indefinitely, and reports the source so the job can surface provider usage.
import { fetchMassiveCandles, fetchEodhdCandles, fetchTwelveDataCandles } from "@/lib/data/candles";
import { fetchYahooCandles, yahooRange } from "@/lib/data/yahoo-candles";
import type { Candle } from "@/lib/data/technicals";
import type { Market } from "@/lib/edges/types";

// ~420 calendar days ≈ 290 trading days — enough for 12-1 momentum (252+21) + buffer.
// IC backfill passes a larger value to span multiple years of forward returns.
const US_DAYS_DEFAULT = 420;

// KNOWN CEILING on the US branch below: Massive is plan-capped at a 2-year
// lookback (HTTP 403 NOT_AUTHORIZED beyond it, measured 2026-07-28), so a US
// `days` above ~730 silently yields only ~500 bars. Yahoo serves 5y for US too
// and is already imported here — but switching the US branch to it changes live
// ResearchAgent scoring inputs, so it is build-order step 4 in
// features/walk-forward-ic-folds/, not a drive-by change.

export interface CandleResult { candles: Candle[]; source: string }

export async function resolveCandles(symbol: string, market: Market, days: number = US_DAYS_DEFAULT): Promise<CandleResult> {
  if (market === "india") {
    const c = await fetchYahooCandles(symbol, yahooRange(days)).catch(() => [] as Candle[]);
    return { candles: c, source: c.length ? "yahoo_india" : "unavailable" };
  }
  let c = await fetchMassiveCandles(symbol, days).catch(() => [] as Candle[]);
  if (c.length) return { candles: c, source: "massive" };
  c = await fetchEodhdCandles(symbol, days).catch(() => [] as Candle[]);
  if (c.length) return { candles: c, source: "eodhd" };
  c = await fetchTwelveDataCandles(symbol, days).catch(() => [] as Candle[]);
  return { candles: c, source: c.length ? "twelvedata" : "unavailable" };
}

// Broad-market benchmark per market (for relative-strength). SPY for US, NIFTY 50
// (^NSEI) for India. Resolved ONCE per run, not per symbol.
export async function resolveBenchmark(market: Market, days: number = US_DAYS_DEFAULT): Promise<CandleResult> {
  if (market === "india") {
    const c = await fetchYahooCandles("^NSEI", yahooRange(days)).catch(() => [] as Candle[]);
    return { candles: c, source: c.length ? "yahoo_india" : "unavailable" };
  }
  return resolveCandles("SPY", "us", days);
}

// Slice a candle series to those dated <= asOf (no look-ahead). Assumes ascending.
export function sliceAsOf(candles: Candle[], asOf: string): Candle[] {
  return candles.filter(c => c.date <= asOf);
}
