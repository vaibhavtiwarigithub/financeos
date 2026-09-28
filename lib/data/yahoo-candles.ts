// Daily OHLC candles from Yahoo's auth-free chart endpoint.
//
// MARKET-AGNOSTIC. This lived in lib/india-data.ts as `fetchIndiaCandles` and was
// treated as India-only — but it was never India-specific. It takes any Yahoo
// symbol and any Yahoo range; `.NS`/`.BO` suffixes are just what India callers
// happened to pass. Measured 2026-07-28:
//
//   AAPL         range=5y -> 1254 bars from 2021-07-28
//   RELIANCE.NS  range=5y -> 1239 bars from 2021-07-27
//
// That matters because Massive (Polygon-backed), which `resolveCandles()` uses
// first for US, returns HTTP 403 NOT_AUTHORIZED beyond a 2-year lookback on the
// current plan. This endpoint is the free, keyless deep-history source for BOTH
// markets — see features/walk-forward-ic-folds/FEATURE_ARCHITECTURE.md Annex B1.
//
// Unlike Yahoo's fundamentals endpoints (v7 quote, v10 quoteSummary), the chart
// endpoint needs no cookie+crumb handshake.
//
// 2026-08-18: US deep history now routes through here too — `resolveCandles()`
// in lib/edges/data.ts goes Yahoo-first for BOTH markets (build-order step 4,
// owner-approved). The old note here claimed that would "alter live ResearchAgent
// scoring inputs"; that was false. `resolveCandles` is reached only from
// lib/edges/compute.ts and lib/edges/ic.ts, both measure-only, and
// lib/research-agent.ts imports nothing from lib/edges. The main research path
// (`fetchUsCandles` in lib/data/candles.ts) has its own local 1y Yahoo fetcher
// and is untouched by this. The real coupling is edge_ic_history -> promotion
// gate, which is why it needed an explicit decision.

import type { Candle } from "@/lib/data/technicals";

/** Yahoo `range` values, shortest to longest. */
export type YahooRange = "5d" | "1mo" | "3mo" | "6mo" | "1y" | "2y" | "3y" | "5y" | "10y" | "max";

export interface YahooCandleOptions {
  /**
   * Ratio-adjust OHLC with Yahoo's adjusted close. This stays opt-in because
   * existing live callers consume raw traded prices, while return studies must
   * not interpret splits and distributions as alpha.
   */
  adjusted?: boolean;
}

export interface YahooCorporateAction {
  symbol: string;
  session: string;
  type: "split" | "dividend";
  /** Shares received for each share held before the effective session. */
  splitRatio?: number;
  /** Per-share cash distribution in the instrument's trading currency. */
  dividendPerShare?: number;
}

export interface YahooRawReplaySeries {
  source: "yahoo_chart_v8";
  priceBasis: "raw_ohlc";
  actionsRequested: true;
  candles: Candle[];
  corporateActions: YahooCorporateAction[];
}

function validOhlc(candle: Candle): boolean {
  return [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= candle.high;
}

/**
 * Fetch an internally coherent raw OHLC series and Yahoo chart split/dividend
 * events in one provider response. Replay callers must still compare these
 * events with their persisted corporate-action ledger and fail closed on a
 * mismatch; this function does not assert that Yahoo is a complete action
 * authority.
 */
export async function fetchYahooRawReplaySeries(
  symbol: string,
  range: YahooRange = "1y",
): Promise<YahooRawReplaySeries | null> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!normalizedSymbol) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalizedSymbol)}?interval=1d&range=${range}&events=div%2Csplits`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const result = (await response.json())?.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};
    if (timestamps.length === 0 || !Array.isArray(quote.open) || !Array.isArray(quote.high)
      || !Array.isArray(quote.low) || !Array.isArray(quote.close)) return null;
    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const candle: Candle = {
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: Number(quote.open[i]),
        high: Number(quote.high[i]),
        low: Number(quote.low[i]),
        close: Number(quote.close[i]),
        volume: Number(quote.volume?.[i] ?? 0),
      };
      if (!validOhlc(candle)) return null;
      candles.push(candle);
    }
    if (candles.some((candle, index) => index > 0 && candle.date <= candles[index - 1].date)) return null;

    const corporateActions: YahooCorporateAction[] = [];
    const events = result.events ?? {};
    for (const event of Object.values(events.splits ?? {}) as Array<Record<string, unknown>>) {
      const timestamp = Number(event.date);
      const numerator = Number(event.numerator);
      const denominator = Number(event.denominator);
      if (!Number.isFinite(timestamp) || !Number.isFinite(numerator) || numerator <= 0
        || !Number.isFinite(denominator) || denominator <= 0) return null;
      corporateActions.push({
        symbol: normalizedSymbol,
        session: new Date(timestamp * 1000).toISOString().slice(0, 10),
        type: "split",
        splitRatio: numerator / denominator,
      });
    }
    for (const event of Object.values(events.dividends ?? {}) as Array<Record<string, unknown>>) {
      const timestamp = Number(event.date);
      const amount = Number(event.amount);
      if (!Number.isFinite(timestamp) || !Number.isFinite(amount) || amount < 0) return null;
      corporateActions.push({
        symbol: normalizedSymbol,
        session: new Date(timestamp * 1000).toISOString().slice(0, 10),
        type: "dividend",
        dividendPerShare: amount,
      });
    }
    corporateActions.sort((a, b) => a.session.localeCompare(b.session) || a.type.localeCompare(b.type));
    return { source: "yahoo_chart_v8", priceBasis: "raw_ohlc", actionsRequested: true, candles, corporateActions };
  } catch {
    return null;
  }
}

/**
 * Smallest Yahoo range that COVERS `days` of calendar history — never less.
 *
 * The inherited `indiaRange` under-served every request between 366 and 500
 * days: it returned "1y" (~247 trading sessions) for a 420-day ask. That is
 * below the 273 sessions 12-1 momentum needs (252 + 21), so `mom_12_1` on the
 * India branch of resolveCandles() was being computed on truncated history at
 * the default depth. Each boundary here is now the range's own calendar length,
 * so the returned window is always >= what the caller asked for.
 */
export function yahooRange(days: number): YahooRange {
  if (days <= 365) return "1y";
  if (days <= 730) return "2y";
  if (days <= 1095) return "3y";
  if (days <= 1825) return "5y";
  return "10y";
}

/**
 * Daily candles for any Yahoo symbol. Returns [] on any failure — callers treat
 * an empty series as "unavailable" rather than as a zero-valued history.
 */
export async function fetchYahooCandles(
  symbol: string,
  range: string = "6mo",
  options: YahooCandleOptions = {},
): Promise<Candle[]> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 3600 }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const ts: number[] = r?.timestamp ?? [];
    const q = r?.indicators?.quote?.[0] ?? {};
    const adjusted: Array<number | null> = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
    if (options.adjusted && adjusted.length === 0) return [];
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close?.[i] == null) continue;
      const rawClose = Number(q.close[i]);
      const adjustedClose = Number(adjusted[i]);
      if (options.adjusted && (!Number.isFinite(adjustedClose) || adjustedClose <= 0)) continue;
      const factor = options.adjusted && Number.isFinite(adjustedClose) && adjustedClose > 0 &&
          Number.isFinite(rawClose) && rawClose > 0
        ? adjustedClose / rawClose
        : 1;
      out.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: Number(q.open?.[i] ?? rawClose) * factor,
        high: Number(q.high?.[i] ?? rawClose) * factor,
        low: Number(q.low?.[i] ?? rawClose) * factor,
        close: rawClose * factor,
        volume: q.volume?.[i] ?? 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}
