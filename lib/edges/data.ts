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
// and is already imported here.
//
// RESOLVED 2026-08-18: the US branch now goes Yahoo-first, so the 2-year ceiling
// no longer binds. The note here previously said switching to Yahoo "changes
// live ResearchAgent scoring inputs" — that was false. `resolveCandles` is
// reached ONLY from lib/edges/compute.ts (EdgeScout) and lib/edges/ic.ts
// (edge-IC), both measure-only; `lib/research-agent.ts` imports nothing from
// lib/edges. The real coupling, which that note omitted, is that edge IC lands
// in `edge_ic_history` and `lib/gates/promotion-gate.ts` reads it — so this was
// an owner decision, taken explicitly, not a drive-by reorder.

export interface CandleResult { candles: Candle[]; source: string }

export async function resolveCandles(symbol: string, market: Market, days: number = US_DAYS_DEFAULT): Promise<CandleResult> {
  if (market === "india") {
    const c = await fetchYahooCandles(symbol, yahooRange(days)).catch(() => [] as Candle[]);
    return { candles: c, source: c.length ? "yahoo_india" : "unavailable" };
  }
  // YAHOO FIRST for US (2026-08-18, owner-approved; build-order step 4 of
  // features/walk-forward-ic-folds/). Two independent reasons:
  //
  // 1. DEPTH. Massive is plan-capped at a 2-year lookback (403 beyond it), which
  //    caps US IC history at ~2y. Net of a 252-day 12-1 momentum lookback that
  //    leaves only ~12 usable non-overlapping 20-day as-of dates — below the
  //    12/fold floor, so walk-forward IC folds were unbuildable on US. Yahoo
  //    serves 5y (AAPL: 1254 bars), giving ~50 as-of dates.
  // 2. BUDGET. Massive per-symbol candles are PACED at 12.5s (5/min), so a
  //    ~300-symbol EdgeScout run had most Massive calls refused and cascaded
  //    into EODHD (free tier 20/day). Measured 2026-08-17: Massive 12, EODHD 20
  //    (its cap), TwelveData 24, everything past that `unavailable`. Yahoo is
  //    keyless, unpaced, and carries no daily budget.
  //
  // `yahooRange(days)` returns the smallest range that COVERS the ask, so the
  // 420-day default maps to "2y" and cannot under-serve it.
  //
  // THIS CHANGES MEASURED IC. `edge_ic_history` rows written from here on are
  // computed on Yahoo bars where they were previously Massive/EODHD/TwelveData.
  // The per-run `providerCounts` in lib/edges/ic.ts records which, so the change
  // is attributable in the data rather than silent — but rows either side of
  // 2026-08-18 are NOT like-for-like and must be segmented before comparison.
  let c = await fetchYahooCandles(symbol, yahooRange(days)).catch(() => [] as Candle[]);
  if (c.length) return { candles: c, source: "yahoo_us" };
  c = await fetchMassiveCandles(symbol, days).catch(() => [] as Candle[]);
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
