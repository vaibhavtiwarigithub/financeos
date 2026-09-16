import type { Candle } from "@/lib/data/technicals";
import { avCachedFetch } from "@/lib/av-cache";

// Crypto OHLCV via AV DIGITAL_CURRENCY_DAILY. Field names identical to
// TIME_SERIES_DAILY (confirmed Stage 0, 2026-09-04). Oldest-first for EMA.
// Cache key AV_CRYPTO_DAILY:BTC separate from equity AV_DAILY/DAILY_ADJ keys.
//
// Extracted from lib/research-agent.ts (Stage 3, 2026-09-16) so the paper-fill
// path can price a crypto fill off the SAME source ResearchAgent scored the
// signal against — a second, unvetted price feed for the fill would let entry
// price and scored price disagree, the exact class of session/quote mismatch
// this codebase's own dimension-diagnostics work has repeatedly had to fix.
export async function fetchCryptoCandles(symbol: string, avKey: string): Promise<{ candles: Candle[]; source: string }> {
  if (!avKey) return { candles: [], source: "unavailable" };
  // Strip -USD suffix: "BTC-USD" → "BTC"
  const coin = symbol.replace(/-USD$/i, "");
  try {
    const json = await avCachedFetch(
      `AV_CRYPTO_DAILY:${coin}`,
      `https://www.alphavantage.co/query?function=DIGITAL_CURRENCY_DAILY&symbol=${coin}&market=USD&apikey=${avKey}`,
    );
    const series = json?.["Time Series (Digital Currency Daily)"];
    if (!series || typeof series !== "object") return { candles: [], source: "unavailable" };
    const candles = Object.entries(series as Record<string, Record<string, string>>)
      .sort(([a], [b]) => a.localeCompare(b)) // oldest first — required for EMA
      .map(([date, d]) => ({
        date,
        open:   parseFloat(d["1. open"]  ?? "0"),
        high:   parseFloat(d["2. high"]  ?? "0"),
        low:    parseFloat(d["3. low"]   ?? "0"),
        close:  parseFloat(d["4. close"] ?? "0"),
        volume: parseFloat(d["5. volume"] ?? "0"),
      }));
    return { candles, source: "alpha_vantage" };
  } catch { return { candles: [], source: "unavailable" }; }
}
