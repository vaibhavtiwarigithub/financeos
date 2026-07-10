// Data Provider Abstraction (Strategic Report Tier-2).
//
// Typed interface contract for interchangeable data providers so callers can
// swap or fallback across AV / FMP / FinancialDatasets / Twelve Data without
// touching call-site logic. Each provider implements the subset of domains it
// supports; unsupported methods return null (not throw).
//
// Usage:
//   const p = getProvider("alpha_vantage");
//   const overview = await p.fetchOverview("AAPL");
//
// Add a provider: implement DataProvider, register it in PROVIDER_REGISTRY.
// The fallback chain (tryProviders) tries each in order, skipping nulls.

import { providerCachedFetch, type ProviderId } from "./provider-fetch";

// ── Result shapes ──────────────────────────────────────────────────────────

export interface OverviewResult {
  symbol: string;
  name?: string;
  sector?: string;
  industry?: string;
  peRatio?: number | null;
  pbRatio?: number | null;
  dividendYield?: number | null;
  marketCap?: number | null;
  revenueGrowthYoY?: number | null;
  earningsGrowthYoY?: number | null;
  grossMargin?: number | null;
  roe?: number | null;
  debtToEquity?: number | null;
  fcfYield?: number | null;
  raw?: unknown; // original provider payload for debugging
}

export interface CandleResult {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NewsResult {
  title: string;
  summary?: string;
  url?: string;
  publishedAt?: string;
  sentiment?: "positive" | "negative" | "neutral" | null;
  sentimentScore?: number | null;
}

// ── Provider interface ─────────────────────────────────────────────────────

export interface DataProvider {
  readonly id: ProviderId;
  readonly label: string;

  /** Company overview / fundamentals. Returns null when unsupported or unavailable. */
  fetchOverview(symbol: string): Promise<OverviewResult | null>;

  /** Daily OHLCV candles (most recent first, up to `limit`). */
  fetchCandles(symbol: string, limit?: number): Promise<CandleResult[] | null>;

  /** News items for a symbol (most recent first, up to `limit`). */
  fetchNews(symbol: string, limit?: number): Promise<NewsResult[] | null>;
}

// ── Alpha Vantage implementation ───────────────────────────────────────────

class AlphaVantageProvider implements DataProvider {
  readonly id = "alpha_vantage" as const;
  readonly label = "Alpha Vantage";

  async fetchOverview(symbol: string): Promise<OverviewResult | null> {
    const key = process.env.ALPHA_VANTAGE_API_KEY;
    if (!key) return null;
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${key}`;
    const json = await providerCachedFetch("alpha_vantage", `AV_OVERVIEW:${symbol}`, url);
    if (!json || !json.Symbol) return null;
    return {
      symbol: json.Symbol,
      name: json.Name ?? undefined,
      sector: json.Sector ?? undefined,
      industry: json.Industry ?? undefined,
      peRatio: parseFloat(json.PERatio) || null,
      pbRatio: parseFloat(json.PriceToBookRatio) || null,
      dividendYield: parseFloat(json.DividendYield) || null,
      marketCap: parseFloat(json.MarketCapitalization) || null,
      revenueGrowthYoY: parseFloat(json.RevenueGrowthYOY) || null,
      earningsGrowthYoY: parseFloat(json.EarningsGrowthYOY) || null,
      grossMargin: parseFloat(json.GrossProfitTTM) && parseFloat(json.RevenueTTM)
        ? parseFloat(json.GrossProfitTTM) / parseFloat(json.RevenueTTM)
        : null,
      roe: parseFloat(json.ReturnOnEquityTTM) || null,
      debtToEquity: parseFloat(json.DebtToEquityRatio) || null,
      raw: json,
    };
  }

  async fetchCandles(symbol: string, limit = 60): Promise<CandleResult[] | null> {
    const key = process.env.ALPHA_VANTAGE_API_KEY;
    if (!key) return null;
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${key}`;
    const json = await providerCachedFetch("alpha_vantage", `AV_DAILY:${symbol}`, url);
    const series = json?.["Time Series (Daily)"];
    if (!series) return null;
    return Object.entries(series)
      .slice(0, limit)
      .map(([date, v]: [string, any]) => ({
        date,
        open: parseFloat(v["1. open"]),
        high: parseFloat(v["2. high"]),
        low: parseFloat(v["3. low"]),
        close: parseFloat(v["4. close"]),
        volume: parseFloat(v["5. volume"]),
      }));
  }

  async fetchNews(symbol: string, limit = 10): Promise<NewsResult[] | null> {
    const key = process.env.ALPHA_VANTAGE_API_KEY;
    if (!key) return null;
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(symbol)}&limit=${limit}&apikey=${key}`;
    const json = await providerCachedFetch("alpha_vantage", `AV_NEWS:${symbol}`, url);
    if (!json?.feed) return null;
    return json.feed.slice(0, limit).map((a: any) => ({
      title: a.title ?? "",
      summary: a.summary ?? undefined,
      url: a.url ?? undefined,
      publishedAt: a.time_published ?? undefined,
      sentimentScore: parseFloat(a.overall_sentiment_score) || null,
      sentiment: a.overall_sentiment_label === "Bullish" ? "positive"
        : a.overall_sentiment_label === "Bearish" ? "negative"
        : "neutral",
    }));
  }
}

// ── FMP (FinancialModelingPrep) implementation ─────────────────────────────

class FMPProvider implements DataProvider {
  readonly id    = "fmp" as const;
  readonly label = "FinancialModelingPrep";

  async fetchOverview(symbol: string): Promise<OverviewResult | null> {
    const key = process.env.FMP_API_KEY;
    if (!key) return null;
    const base = "https://financialmodelingprep.com/stable";
    const bad  = (j: any) => !Array.isArray(j) || j.length === 0 || ("Error Message" in (j[0] ?? {}));
    try {
      const [ratios, metrics] = await Promise.all([
        providerCachedFetch("fmp", `FMP_RATIOS:${symbol}`,
          `${base}/ratios-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
          { timeoutMs: 8000, isThrottled: bad }),
        providerCachedFetch("fmp", `FMP_KEYMETRICS:${symbol}`,
          `${base}/key-metrics-ttm?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
          { timeoutMs: 8000, isThrottled: bad }),
      ]);
      const r = Array.isArray(ratios)  ? ratios[0]  : null;
      const m = Array.isArray(metrics) ? metrics[0] : null;
      if (!r && !m) return null;
      const fin = (v: any): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return {
        symbol,
        peRatio:          fin(r?.priceToEarningsRatioTTM),
        grossMargin:      fin(r?.grossProfitMarginTTM),
        roe:              fin(m?.returnOnEquityTTM),
        debtToEquity:     fin(r?.debtToEquityRatioTTM),
        fcfYield:         fin(m?.freeCashFlowYieldTTM),
        raw: { ratios: r, metrics: m },
      };
    } catch { return null; }
  }

  async fetchCandles(symbol: string, limit = 60): Promise<CandleResult[] | null> {
    const key = process.env.FMP_API_KEY;
    if (!key) return null;
    try {
      const json = await providerCachedFetch("fmp", `FMP_DAILY:${symbol}`,
        `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(symbol)}?timeseries=${limit}&apikey=${key}`,
        { timeoutMs: 8000 });
      const series: any[] = json?.historical ?? [];
      return series.slice(0, limit).map((d: any) => ({
        date:   d.date,
        open:   +d.open,
        high:   +d.high,
        low:    +d.low,
        close:  +d.close,
        volume: +d.volume,
      }));
    } catch { return null; }
  }

  async fetchNews(symbol: string, limit = 10): Promise<NewsResult[] | null> {
    const key = process.env.FMP_API_KEY;
    if (!key) return null;
    try {
      const json = await providerCachedFetch("fmp", `FMP_NEWS:${symbol}`,
        `https://financialmodelingprep.com/api/v3/stock_news?tickers=${encodeURIComponent(symbol)}&limit=${limit}&apikey=${key}`,
        { timeoutMs: 8000 });
      if (!Array.isArray(json)) return null;
      return json.slice(0, limit).map((a: any) => ({
        title:       a.title ?? "",
        summary:     a.text?.slice(0, 300) ?? undefined,
        url:         a.url ?? undefined,
        publishedAt: a.publishedDate ?? undefined,
        sentiment:   null,
      }));
    } catch { return null; }
  }
}

// ── Null (stub) implementation — safe default for unimplemented providers ──

class NullProvider implements DataProvider {
  constructor(readonly id: ProviderId, readonly label: string) {}
  async fetchOverview() { return null; }
  async fetchCandles() { return null; }
  async fetchNews() { return null; }
}

// ── Registry ───────────────────────────────────────────────────────────────

const PROVIDER_REGISTRY: Partial<Record<ProviderId, DataProvider>> = {
  alpha_vantage: new AlphaVantageProvider(),
  fmp:           new FMPProvider(),
  // Add more: financialdatasets, twelvedata, eodhd — implement the DataProvider
  // interface and register here. NullProvider is the safe fallback for any id
  // not in this map.
};

/** Get a provider by id. Returns a NullProvider (all nulls) for unimplemented IDs. */
export function getProvider(id: ProviderId): DataProvider {
  return PROVIDER_REGISTRY[id] ?? new NullProvider(id, id);
}

/**
 * Try each provider in order, return first non-null result.
 * Useful for graceful fallback: tryProviders(["alpha_vantage","fmp"], p => p.fetchOverview(symbol)).
 */
export async function tryProviders<T>(
  ids: ProviderId[],
  fn: (provider: DataProvider) => Promise<T | null>,
): Promise<T | null> {
  for (const id of ids) {
    const result = await fn(getProvider(id));
    if (result != null) return result;
  }
  return null;
}
