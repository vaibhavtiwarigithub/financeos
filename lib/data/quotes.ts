/**
 * Deterministic Quote Adapter — Phase 0
 * All prices come from real market APIs with timestamp + source provenance.
 * Never calls an LLM for price data.
 */

import { avCachedFetch } from "@/lib/av-cache";

export type QuoteSource = "alpha_vantage" | "price_cache" | "unavailable";

export interface DeterministicQuote {
  symbol: string;
  price: number;        // mid price
  bid: number | null;
  ask: number | null;
  change: number | null;
  changePct: number | null;
  source: QuoteSource;
  retrievedAt: string;
  stale: boolean;       // true if > 15 min old during market hours
}

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours() + et.getMinutes() / 60;
  return h >= 9.5 && h < 16;
}

function isStale(retrievedAt: string): boolean {
  if (!isMarketHours()) return false; // outside hours: cached EOD is fine
  return Date.now() - new Date(retrievedAt).getTime() > STALE_THRESHOLD_MS;
}

/** Fetch a real-time quote from Alpha Vantage GLOBAL_QUOTE (direct HTTP, no MCP).
 * Day-cached — AV free tier is 25 calls/day and this was previously calling
 * uncached on every page load (e.g. up to 26 symbols per Live Portfolio
 * refresh), exhausting the daily budget almost immediately. */
async function fetchAVQuote(symbol: string, avKey: string): Promise<DeterministicQuote | null> {
  if (!avKey) return null;
  const retrievedAt = new Date().toISOString();
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${avKey}`;
    const json = await avCachedFetch(`GLOBAL_QUOTE:${symbol}`, url);
    const q = json?.["Global Quote"];
    if (!q || !q["05. price"]) return null;

    const price = parseFloat(q["05. price"]);
    const change = parseFloat(q["09. change"] ?? "0");
    const changePct = parseFloat((q["10. change percent"] ?? "0").replace("%", ""));
    if (price <= 0) return null;

    return {
      symbol,
      price,
      bid: null,   // AV GLOBAL_QUOTE doesn't provide bid/ask
      ask: null,
      change,
      changePct,
      source: "alpha_vantage",
      retrievedAt,
      stale: false,
    };
  } catch {
    return null;
  }
}

/** Try price_cache for most recent closing price (EOD fallback) */
async function fetchCachedQuote(symbol: string, supabase: any): Promise<DeterministicQuote | null> {
  try {
    const { data } = await supabase
      .from("price_cache")
      .select("close, cached_at, date")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(1)
      .single();

    if (!data || !data.close) return null;

    const retrievedAt = data.cached_at ?? data.date + "T20:00:00Z";
    return {
      symbol,
      price: Number(data.close),
      bid: null,
      ask: null,
      change: null,
      changePct: null,
      source: "price_cache",
      retrievedAt,
      stale: isStale(retrievedAt),
    };
  } catch {
    return null;
  }
}

/**
 * Get a deterministic quote with provenance.
 * Priority: AV GLOBAL_QUOTE → price_cache (EOD) → unavailable
 * During market hours: price_cache stale if > 15 min old.
 */
export async function getQuote(symbol: string, supabase: any): Promise<DeterministicQuote> {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  const unavailable: DeterministicQuote = {
    symbol, price: 0, bid: null, ask: null, change: null, changePct: null,
    source: "unavailable", retrievedAt: new Date().toISOString(), stale: true,
  };

  // 1. Alpha Vantage real-time (most accurate during market hours)
  const avQuote = await fetchAVQuote(symbol, avKey);
  if (avQuote) return avQuote;

  // 2. price_cache (EOD — fine outside market hours)
  const cached = await fetchCachedQuote(symbol, supabase);
  if (cached) return cached;

  return unavailable;
}

/**
 * Batch quote fetch — one AV call per symbol (up to 25/day budget).
 * Returns map of symbol → quote.
 */
export async function getBatchQuotes(
  symbols: string[],
  supabase: any
): Promise<Record<string, DeterministicQuote>> {
  const results: Record<string, DeterministicQuote> = {};
  // Parallel with small concurrency limit to avoid AV rate-limiting
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 5) chunks.push(symbols.slice(i, i + 5));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async s => { results[s] = await getQuote(s, supabase); }));
  }
  return results;
}

/**
 * Fill price for paper trades:
 * - During market hours: use ask price if available, else price + 0.05% (bid/ask spread model)
 * - Apply additional 0.05% slippage
 */
export function computeFillPrice(quote: DeterministicQuote): number {
  const base = quote.ask ?? quote.price;
  const slippage = 0.0005; // 0.05%
  return parseFloat((base * (1 + slippage)).toFixed(4));
}
