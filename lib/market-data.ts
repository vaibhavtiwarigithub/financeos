import { getBatchQuotes } from "@/lib/data/quotes";
import { createServiceClient } from "@/lib/supabase/service";

export type PriceSource = "robinhood" | "financial_datasets" | "unavailable";

export type Quote = {
  symbol: string;
  price: number;
  source: PriceSource;
  fetchedAt: string;
};

// Fetch prices via the deterministic quote adapter (lib/data/quotes.ts):
// Massive snapshot (one HTTP call for all symbols) → Alpha Vantage per-symbol
// → price_cache (EOD) → unavailable. All real market REST, NO LLM/subprocess.
// This mirrors app/api/markets/quotes and getBatchQuotes — never estimates.
export async function fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  if (symbols.length === 0) return {};

  const fetchedAt = new Date().toISOString();
  const unavailable = (): Record<string, Quote> =>
    Object.fromEntries(
      symbols.map(s => [s, { symbol: s, price: 0, source: "unavailable" as PriceSource, fetchedAt }])
    );

  try {
    const supabase = createServiceClient();
    const batch = await getBatchQuotes(symbols, supabase);
    const result: Record<string, Quote> = {};

    for (const sym of symbols) {
      const dq = batch[sym];
      const price = dq && Number.isFinite(dq.price) && dq.price > 0 ? dq.price : 0;
      result[sym] = {
        symbol: sym,
        price,
        // Prices here come from Massive / Alpha Vantage / price_cache (real
        // market data), never Robinhood — surface them as financial_datasets.
        source: price > 0 ? "financial_datasets" : "unavailable",
        fetchedAt,
      };
    }
    return result;
  } catch {
    return unavailable();
  }
}

export async function fetchQuote(symbol: string): Promise<Quote> {
  const quotes = await fetchQuotes([symbol]);
  return quotes[symbol];
}
