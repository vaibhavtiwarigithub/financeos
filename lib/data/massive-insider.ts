import { providerCachedFetch } from "@/lib/data/provider-fetch";

// Insider sentiment from Massive's SEC Form 4 dataset (/stocks/filings/vX/form-4).
// Unlike Alpha Vantage's INSIDER_TRANSACTIONS (25/day shared cap, exhausted by
// the daily universe) this endpoint is on the Massive plan and returns full
// transaction detail — code, shares, price, value — so we can score real
// buy-vs-sell conviction. Returns the SAME {score, summary, available} contract
// as the AV/EDGAR scorers so it slots into resolveInsider as the primary source.
//
// Only OPEN-MARKET transactions carry sentiment: P = open-market purchase (bull),
// S = open-market sale (bear). Grants/awards (A), option exercises (M), gifts (G)
// etc. are compensation mechanics, not conviction, and are excluded.

const MASSIVE_BASE = "https://api.massive.com";
const MIN_INSIDER_TRANSACTIONS = 3;

interface Form4Txn {
  transaction_date?: string;
  transaction_code?: string;
  transaction_shares?: number;
  transaction_price_per_share?: number;
  transaction_value?: number;
}

export async function scoreMassiveInsider(symbol: string): Promise<{ score: number; summary: string; available: boolean }> {
  const key = process.env.MASSIVE_API_KEY ?? "";
  if (!key) return { score: 50, summary: "Massive key missing.", available: false };
  // De-suffix NSE/BSE tickers just in case; Massive Form 4 is US-only, so a
  // suffixed India symbol simply returns nothing → unavailable (correct).
  const ticker = symbol.replace(/\.(NS|BO|US)$/i, "").toUpperCase();
  try {
    const url = `${MASSIVE_BASE}/stocks/filings/vX/form-4?tickers.any_of=${encodeURIComponent(ticker)}&limit=200&apiKey=${key}`;
    const data = await providerCachedFetch("massive", `MASSIVE_FORM4:${ticker}`, url, { timeoutMs: 8000, maxAgeDays: 1 });
    const rows: Form4Txn[] = Array.isArray((data as any)?.results) ? (data as any).results : [];
    if (!rows.length) return { score: 50, summary: "No Form 4 filings returned.", available: false };

    const cutoff = Date.now() - 90 * 86_400_000;
    let buyValue = 0, sellValue = 0, buyCount = 0, sellCount = 0;
    for (const t of rows) {
      const ts = new Date(t.transaction_date ?? "").getTime();
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const code = (t.transaction_code ?? "").toUpperCase();
      if (code !== "P" && code !== "S") continue; // only open-market trades carry sentiment
      const shares = Math.abs(Number(t.transaction_shares ?? 0));
      const price = Number(t.transaction_price_per_share ?? 0);
      const value = Number.isFinite(t.transaction_value as number) && (t.transaction_value as number) > 0
        ? Number(t.transaction_value)
        : shares * price;
      if (!Number.isFinite(value) || value <= 0) continue;
      if (code === "P") { buyValue += value; buyCount++; }
      else { sellValue += value; sellCount++; }
    }

    const n = buyCount + sellCount;
    if (n < MIN_INSIDER_TRANSACTIONS) {
      return { score: 50, summary: `Only ${n} open-market insider trade(s) in 90d — too few to score.`, available: false };
    }
    const total = buyValue + sellValue;
    if (total === 0) return { score: 50, summary: `${n} insider trades but no valuable buy/sell.`, available: false };

    const buyRatio = buyValue / total;
    const score = Math.round(10 + buyRatio * 80); // 100% buying → 90, 100% selling → 10
    const fmt = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K` : `$${v.toFixed(0)}`;
    const summary = `${buyCount} open-market buys (${fmt(buyValue)}) vs ${sellCount} sells (${fmt(sellValue)}) in 90d. Buy ratio ${(buyRatio * 100).toFixed(0)}%.`;
    return { score, summary, available: true };
  } catch {
    return { score: 50, summary: "Massive Form 4 fetch failed.", available: false };
  }
}
