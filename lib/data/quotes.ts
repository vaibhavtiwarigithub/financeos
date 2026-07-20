/**
 * Deterministic Quote Adapter — Phase 0
 * All prices come from real market APIs with timestamp + source provenance.
 * Never calls an LLM for price data.
 */

import { avCachedFetch } from "@/lib/av-cache";

export type QuoteSource = "massive" | "alpha_vantage" | "price_cache" | "unavailable";

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
  const age = Date.now() - new Date(retrievedAt).getTime();
  if (!Number.isFinite(age) || age < 0) return true;
  // Outside market hours an EOD close is valid, but not indefinitely. Four
  // calendar days covers ordinary weekends and one-day exchange holidays while
  // refusing an abandoned cache row as today's executable paper-exit price.
  if (!isMarketHours()) return age > 4 * 86_400_000;
  return age > STALE_THRESHOLD_MS;
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

/**
 * Batch-fetch quotes for many symbols in ONE Massive HTTP call via the
 * "Full Market Snapshot" endpoint's `tickers` filter (Polygon-compatible
 * `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=A,B,C`), instead of
 * one Alpha Vantage call per symbol. This is the primary batch path — AV
 * (25 calls/day free tier) can't cover a ~26-symbol Live Portfolio refresh
 * in a single page load, so every symbol past the first ~25 came back
 * "unavailable" and fell back to avgCost (0% P&L, "—" day change).
 * Massive is already used elsewhere in this repo (app/api/markets/overview,
 * app/api/markets/quote(s)) via the same prev-day-bar pattern.
 */
async function fetchMassiveBatchQuotes(
  symbols: string[],
  apiKey: string
): Promise<Record<string, DeterministicQuote>> {
  const results: Record<string, DeterministicQuote> = {};
  if (!apiKey || symbols.length === 0) return results;

  // API allows up to 250 tickers per call; batch in chunks to be safe.
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 100) chunks.push(symbols.slice(i, i + 100));

  for (const chunk of chunks) {
    const retrievedAt = new Date().toISOString();
    try {
      const url = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(chunk.join(","))}&apiKey=${apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      const tickers: any[] = data?.tickers ?? [];
      for (const t of tickers) {
        const sym = t?.ticker;
        if (!sym) continue;
        const price = t?.day?.c ?? t?.min?.c ?? t?.prevDay?.c;
        if (!price || price <= 0) continue;
        const prevClose = t?.prevDay?.c;
        const change = t?.todaysChange ?? (prevClose ? price - prevClose : null);
        const changePct = t?.todaysChangePerc ?? (prevClose ? ((price - prevClose) / prevClose) * 100 : null);
        results[sym] = {
          symbol: sym,
          price,
          bid: t?.lastQuote?.p ?? null,
          ask: t?.lastQuote?.P ?? null,
          change: change ?? null,
          changePct: changePct ?? null,
          source: "massive",
          retrievedAt,
          stale: false,
        };
      }
    } catch {
      // fall through — leaves this chunk's symbols to be filled by AV/cache fallback
    }
  }

  return results;
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

    // Freshness follows the market date represented by the bar, not when an old
    // row happened to be re-read or re-cached.
    const retrievedAt = data.date + "T20:00:00Z";
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
 * Priority: Massive snapshot (FREE, uncapped) → price_cache (EOD, free) →
 * Alpha Vantage GLOBAL_QUOTE (LAST — 25/day free cap) → unavailable.
 *
 * AV is deliberately last so US+India research can score every symbol without
 * ever leading with the capped provider. It's only reached when both the free
 * Massive snapshot AND the local EOD cache miss (e.g. a thin/new symbol Massive
 * doesn't cover). Mirrors getBatchQuotes' Massive-first ordering.
 */
export async function getQuote(symbol: string, supabase: any): Promise<DeterministicQuote> {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  const massiveKey = process.env.MASSIVE_API_KEY ?? "";
  const unavailable: DeterministicQuote = {
    symbol, price: 0, bid: null, ask: null, change: null, changePct: null,
    source: "unavailable", retrievedAt: new Date().toISOString(), stale: true,
  };

  // 1. Massive snapshot — free, no daily cap (single-symbol via the batch path).
  const massive = await fetchMassiveBatchQuotes([symbol], massiveKey);
  if (massive[symbol]) return massive[symbol];

  // 2. price_cache (EOD — fine outside market hours, free).
  const cached = await fetchCachedQuote(symbol, supabase);
  if (cached && !cached.stale) return cached;

  // 3. Alpha Vantage — LAST resort only; every hit counts against the 25/day cap.
  const avQuote = await fetchAVQuote(symbol, avKey);
  if (avQuote) return avQuote;

  // A stale close is still useful to read-only callers, but it remains marked
  // stale so execution and exit paths can fail closed.
  return cached ?? unavailable;
}

/**
 * Batch quote fetch.
 * Priority: Massive snapshot (one HTTP call for all symbols) → fresh price_cache
 * → Alpha Vantage reserve → explicitly stale cache → unavailable.
 * Massive is primary because AV's 25 calls/day free tier can't cover a
 * ~26-symbol portfolio refresh — see fetchMassiveBatchQuotes above.
 */
export async function getBatchQuotes(
  symbols: string[],
  supabase: any
): Promise<Record<string, DeterministicQuote>> {
  const results: Record<string, DeterministicQuote> = {};
  if (symbols.length === 0) return results;

  const massiveKey = process.env.MASSIVE_API_KEY ?? "";
  const massiveResults = await fetchMassiveBatchQuotes(symbols, massiveKey);
  Object.assign(results, massiveResults);

  const remaining = symbols.filter(s => !results[s]);
  if (remaining.length > 0) {
    // Do not call getQuote() here: it would retry Massive once per missed
    // symbol, recreating the N-symbol burst this batch path exists to prevent.
    // Read the durable EOD cache first, then spend scarce AV calls only for the
    // genuinely unresolved tail.
    const chunks: string[][] = [];
    for (let i = 0; i < remaining.length; i += 5) chunks.push(remaining.slice(i, i + 5));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async s => {
        const cached = await fetchCachedQuote(s, supabase);
        if (cached && !cached.stale) {
          results[s] = cached;
          return;
        }
        const av = await fetchAVQuote(s, process.env.ALPHA_VANTAGE_API_KEY ?? "");
        results[s] = av ?? cached ?? {
          symbol: s, price: 0, bid: null, ask: null, change: null, changePct: null,
          source: "unavailable", retrievedAt: new Date().toISOString(), stale: true,
        };
      }));
    }
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

/** Conservative paper SELL fill when no executable bid is available. */
export function computeExitFillPrice(price: number, bid?: number | null): number {
  const base = bid != null && Number.isFinite(bid) && bid > 0 ? bid : price;
  return parseFloat((base * (1 - 0.0005)).toFixed(4));
}
