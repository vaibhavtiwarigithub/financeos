import { providerCachedFetch } from "@/lib/data/provider-fetch";

// Analyst-recommendation dimension via Finnhub /stock/recommendation (free tier,
// verified). Wall-Street buy/hold/sell consensus is a genuine predictive axis
// that was entirely absent from scoring. US equities only (Finnhub free covers
// US analyst coverage; ETFs/ADRs/India get no analyst dimension → excluded from
// the weighted score via the availability mask).
//
// Returns { score, evidence, available }. score 0-100 where 100 = unanimous
// strong-buy, 50 = hold, 0 = unanimous strong-sell. `available:false` when there
// are too few analysts (noise) or no data — so it's excluded, never faked.

const MIN_ANALYSTS = 3;

export async function scoreAnalyst(symbol: string): Promise<{ score: number; evidence: Record<string, unknown>; available: boolean }> {
  const key = process.env.FINNHUB_API_KEY ?? "";
  if (!key) return { score: 50, evidence: { note: "no finnhub key" }, available: false };
  try {
    const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${key}`;
    const json = await providerCachedFetch("finnhub", `FINNHUB_REC:${symbol}`, url, {
      timeoutMs: 6000,
      isThrottled: (j) => !Array.isArray(j),
    });
    const latest = Array.isArray(json) ? json[0] : null;
    if (!latest) return { score: 50, evidence: { note: "no analyst coverage" }, available: false };

    const sB = Number(latest.strongBuy ?? 0), b = Number(latest.buy ?? 0), h = Number(latest.hold ?? 0);
    const s = Number(latest.sell ?? 0), sS = Number(latest.strongSell ?? 0);
    const total = sB + b + h + s + sS;
    if (total < MIN_ANALYSTS) {
      return { score: 50, evidence: { note: `only ${total} analyst(s) — too few to score`, period: latest.period }, available: false };
    }
    // Weighted consensus: strongBuy=100 … strongSell=0.
    const score = Math.round((sB * 100 + b * 75 + h * 50 + s * 25 + sS * 0) / total);
    return {
      score: Math.max(0, Math.min(100, score)),
      evidence: {
        strong_buy: sB, buy: b, hold: h, sell: s, strong_sell: sS,
        total_analysts: total, period: latest.period, source: "finnhub",
      },
      available: true,
    };
  } catch {
    return { score: 50, evidence: { note: "analyst fetch failed" }, available: false };
  }
}
