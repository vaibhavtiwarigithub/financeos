import { providerCachedFetch } from "@/lib/data/provider-fetch";
import type { Candle } from "@/lib/data/technicals";

// US daily-candle adapters, in fallback priority. RSI/EMA are computed LOCALLY
// from these candles (lib/data/technicals.ts) — we never buy an "indicator API".
// Yahoo Finance (no key, no observed rate limit, 251 bars) is primary.
// Massive/EODHD/TwelveData are fallbacks; AV is last resort.
//
// Each is day-cached via providerCachedFetch under its own provider budget.
//
// Recency guard: any source whose newest bar is older than MAX_BAR_AGE_DAYS is
// rejected regardless of bar count. Prevents stale provider caches (e.g. Massive
// serving 07-17 bars on 07-22) from silently corrupting EMA/RSI scoring.

function fmtDate(d: Date): string { return d.toISOString().slice(0, 10); }

// 4 calendar days handles: normal session (0-1d), weekend (2d), holiday weekend (3d).
// Stale caches (5+d) are rejected.
const MAX_BAR_AGE_DAYS = 4;

export function newestBarIsStale(candles: Candle[]): boolean {
  if (candles.length === 0) return true;
  const newest = candles[candles.length - 1].date; // "YYYY-MM-DD"
  return Date.now() - new Date(newest + "T23:59:59Z").getTime() > MAX_BAR_AGE_DAYS * 86_400_000;
}

// Yahoo Finance v8 chart — no API key, no observed rate limit, 251 adjusted bars.
// Works for US (AAPL) and India (RELIANCE.NS). Primary source for fetchUsCandles.
export async function fetchYahooCandles(symbol: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
  try {
    const json = await providerCachedFetch("yahoo", `YAHOO_CANDLES:${symbol}`, url, { timeoutMs: 8000 });
    const result = json?.chart?.result?.[0];
    if (!result) return [];
    const timestamps: number[] = result.timestamp ?? [];
    const adjClose: number[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};
    return timestamps
      .map((t: number, i: number) => ({
        date: fmtDate(new Date(t * 1000)),
        open: quote.open?.[i],
        high: quote.high?.[i],
        low: quote.low?.[i],
        close: adjClose[i] ?? quote.close?.[i],
        volume: quote.volume?.[i] ?? 0,
      }))
      .filter((c: Candle) => Number.isFinite(c.close) && c.close > 0);
  } catch { return []; }
}

// Massive / Polygon aggregates: /v2/aggs/ticker/{t}/range/1/day/{from}/{to}
export async function fetchMassiveCandles(symbol: string, days = 160): Promise<Candle[]> {
  const key = process.env.MASSIVE_API_KEY ?? "";
  if (!key) return [];
  const to = new Date();
  const from = new Date(to.getTime() - days * 2 * 86400000); // 2× calendar for weekends/holidays
  const url = `https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${fmtDate(from)}/${fmtDate(to)}?adjusted=true&sort=asc&limit=5000&apiKey=${key}`;
  try {
    const json = await providerCachedFetch("massive", `MASSIVE_CANDLES:${symbol}:${days}`, url, { timeoutMs: 8000 });
    const results: any[] = json?.results ?? [];
    return results
      .map((r: any) => ({
        date: fmtDate(new Date(r.t)),
        open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v,
      }))
      .filter((c: Candle) => Number.isFinite(c.close) && c.close > 0);
  } catch { return []; }
}

// EODHD EOD: /api/eod/{SYMBOL}.US?fmt=json — ascending, adjusted_close available.
export async function fetchEodhdCandles(symbol: string, days = 160): Promise<Candle[]> {
  const key = process.env.EODHD_API_KEY ?? "";
  if (!key) return [];
  const from = fmtDate(new Date(Date.now() - days * 2 * 86400000));
  const url = `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}.US?api_token=${key}&fmt=json&order=a&from=${from}`;
  try {
    const json = await providerCachedFetch("eodhd", `EODHD_CANDLES:${symbol}:${days}`, url, { timeoutMs: 8000 });
    const rows: any[] = Array.isArray(json) ? json : [];
    return rows
      .map((r: any) => ({
        date: String(r.date),
        open: r.open, high: r.high, low: r.low,
        close: r.adjusted_close ?? r.close, volume: r.volume,
      }))
      .filter((c: Candle) => Number.isFinite(c.close) && c.close > 0);
  } catch { return []; }
}

// Twelve Data time_series: /time_series?symbol=X&interval=1day (returns newest-first).
export async function fetchTwelveDataCandles(symbol: string, days = 160): Promise<Candle[]> {
  const key = process.env.TWELVEDATA_API_KEY ?? "";
  if (!key) return [];
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${days}&apikey=${key}`;
  try {
    const json = await providerCachedFetch("twelvedata", `TD_CANDLES:${symbol}:${days}`, url, {
      timeoutMs: 8000,
      isThrottled: (j) => j?.status === "error",
    });
    const rows: any[] = json?.values ?? [];
    return rows
      .map((r: any) => ({
        date: String(r.datetime),
        open: parseFloat(r.open), high: parseFloat(r.high), low: parseFloat(r.low),
        close: parseFloat(r.close), volume: parseFloat(r.volume ?? "0"),
      }))
      .filter((c: Candle) => Number.isFinite(c.close) && c.close > 0)
      .sort((a: Candle, b: Candle) => a.date.localeCompare(b.date)); // oldest first for EMA
  } catch { return []; }
}

// US candle resolver: Yahoo → Massive → EODHD → Twelve Data → (caller's AV fallback).
// A source is accepted only when it has >= minCandles bars AND its newest bar is
// within MAX_BAR_AGE_DAYS. The recency guard prevents stale provider caches from
// silently corrupting EMA/RSI computation.
// minCandles default raised to 60: EMA50 needs 50+ data points; 60 gives headroom.
export async function fetchUsCandles(
  symbol: string,
  avFallback: () => Promise<Candle[]>,
  minCandles = 60,
): Promise<{ candles: Candle[]; source: string }> {
  const accept = (c: Candle[]) => c.length >= minCandles && !newestBarIsStale(c);

  const y = await fetchYahooCandles(symbol);
  if (accept(y)) return { candles: y, source: "yahoo" };
  const m = await fetchMassiveCandles(symbol);
  if (accept(m)) return { candles: m, source: "massive" };
  const e = await fetchEodhdCandles(symbol);
  if (accept(e)) return { candles: e, source: "eodhd" };
  const t = await fetchTwelveDataCandles(symbol);
  if (accept(t)) return { candles: t, source: "twelvedata" };
  const av = await avFallback().catch(() => [] as Candle[]);
  return { candles: av, source: av.length ? "alpha_vantage" : "unavailable" };
}
