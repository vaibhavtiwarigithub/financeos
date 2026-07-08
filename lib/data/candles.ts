import { providerCachedFetch } from "@/lib/data/provider-fetch";
import type { Candle } from "@/lib/data/technicals";

// US daily-candle adapters, in fallback priority. RSI/EMA are computed LOCALLY
// from these candles (lib/data/technicals.ts) — we never buy an "indicator API".
// Massive (Polygon-compatible, no daily cap, 5/min) is primary so the scarce
// Alpha Vantage 25/day budget is no longer spent on candles. EODHD + Twelve
// Data are additional free-tier US fallbacks; AV is last resort.
//
// Each is day-cached via providerCachedFetch under its own provider budget.

function fmtDate(d: Date): string { return d.toISOString().slice(0, 10); }

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

// US candle resolver: Massive → EODHD → Twelve Data → (caller's AV fallback).
// Returns the first source with >= minCandles usable bars. `avFallback` lets the
// caller keep Alpha Vantage as the final tier without this module importing it.
export async function fetchUsCandles(
  symbol: string,
  avFallback: () => Promise<Candle[]>,
  minCandles = 15,
): Promise<{ candles: Candle[]; source: string }> {
  const m = await fetchMassiveCandles(symbol);
  if (m.length >= minCandles) return { candles: m, source: "massive" };
  const e = await fetchEodhdCandles(symbol);
  if (e.length >= minCandles) return { candles: e, source: "eodhd" };
  const t = await fetchTwelveDataCandles(symbol);
  if (t.length >= minCandles) return { candles: t, source: "twelvedata" };
  const av = await avFallback().catch(() => [] as Candle[]);
  return { candles: av, source: av.length ? "alpha_vantage" : "unavailable" };
}
