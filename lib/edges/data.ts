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
// CORRECTION (2026-08-18): the note here used to say switching the US branch to
// Yahoo "changes live ResearchAgent scoring inputs". That is not true —
// `resolveCandles` is reached ONLY from lib/edges/compute.ts (EdgeScout) and
// lib/edges/ic.ts (edge-IC), both measure-only; `lib/research-agent.ts` imports
// nothing from lib/edges. The real reason to be careful is different: edge IC is
// what `lib/gates/promotion-gate.ts` reasons about, so changing which provider
// serves a symbol changes a measured input to a promotion decision. Yahoo is
// therefore added as a LAST RESORT (additive, rescues `unavailable` only) rather
// than promoted ahead of the budgeted providers.

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
  if (c.length) return { candles: c, source: "twelvedata" };
  // LAST RESORT ONLY, added 2026-08-18. Strictly additive: every branch above is
  // unchanged, so no symbol that resolves today changes source or value — this
  // only rescues symbols that previously returned `unavailable`.
  //
  // Why it matters: Massive per-symbol candles are PACED at 12.5s (5/min), so a
  // 300-symbol EdgeScout run gets most Massive calls refused and cascades into
  // EODHD, whose free-tier budget is 20/day. Measured 2026-08-17: Massive
  // resolved 12 symbols, EODHD exactly 20 (its cap), TwelveData 24 — everything
  // past that got nothing at all. Yahoo carries NO daily budget
  // (PROVIDERS.yahoo.dailyBudget === null) and already serves the India branch
  // of this same function.
  //
  // Deliberately NOT moved ahead of EODHD/TwelveData, which is what would
  // actually cut the budget spend: doing so changes WHICH provider serves a
  // symbol, and therefore the measured IC that `lib/gates/promotion-gate.ts`
  // reasons about. That is a decision-affecting change and needs its own
  // approval, not a drive-by reorder.
  c = await fetchYahooCandles(symbol, yahooRange(days)).catch(() => [] as Candle[]);
  return { candles: c, source: c.length ? "yahoo_us_last_resort" : "unavailable" };
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
