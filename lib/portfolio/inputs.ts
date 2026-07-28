// Cheap, fail-soft volatility input for the Portfolio Constructor. 20-trading-day
// stdev of daily returns, as a fraction (e.g. 0.02 = 2%/day). Falls back to a
// sector-agnostic 2% default when candles are unavailable — the constructor
// treats that as "typical" volatility rather than blocking a trade over a data gap.

import { fetchYahooCandles } from "@/lib/india-data";

const DEFAULT_DAILY_VOL = 0.02;

function stdevOfReturns(closes: number[]): number | null {
  if (closes.length < 5) return null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (returns.length < 4) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

export async function estimateDailyVolPct(symbol: string, market: "us" | "india", supabase: any): Promise<number> {
  try {
    if (market === "india") {
      const candles = await fetchYahooCandles(symbol, "1mo");
      const closes = candles.slice(-21).map(c => c.close);
      return stdevOfReturns(closes) ?? DEFAULT_DAILY_VOL;
    }
    const { data } = await supabase
      .from("price_cache")
      .select("close")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(21);
    const closes = (data ?? []).map((r: any) => parseFloat(r.close)).reverse();
    return stdevOfReturns(closes) ?? DEFAULT_DAILY_VOL;
  } catch {
    return DEFAULT_DAILY_VOL;
  }
}
