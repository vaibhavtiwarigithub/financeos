export type BreakdownDomain = "fundamental" | "technical" | "sentiment" | "macro";

export function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function breakdownWithStatus(
  value: unknown,
  domain: BreakdownDomain,
  market: string,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const breakdown = value as Record<string, unknown>;
  if (typeof breakdown.status === "string") return breakdown;

  if (market === "india" && (domain === "sentiment" || domain === "macro")) {
    return { ...breakdown, status: "inapplicable" };
  }
  const evidenceKeys: Record<BreakdownDomain, string[]> = {
    fundamental: ["pe_ratio", "profit_margin", "roe", "eps", "revenue_growth_yoy"],
    technical: ["rsi14", "ema20", "ema50", "price"],
    sentiment: ["bullish_pct", "bearish_pct", "sample_size"],
    macro: ["danger_score", "regime", "as_of", "week_of"],
  };
  const available = evidenceKeys[domain].some((key) => breakdown[key] != null);
  if (domain === "technical" && available) {
    const price = Number(breakdown.price);
    const ema20 = Number(breakdown.ema20);
    const ema50 = Number(breakdown.ema50);
    return {
      ...breakdown,
      status: "available",
      price_vs_ema20: breakdown.price_vs_ema20
        ?? (Number.isFinite(price) && Number.isFinite(ema20) ? (price > ema20 ? "above" : "below") : null),
      price_vs_ema50: breakdown.price_vs_ema50
        ?? (Number.isFinite(price) && Number.isFinite(ema50) ? (price > ema50 ? "above" : "below") : null),
    };
  }
  return { ...breakdown, status: available ? "available" : "unavailable" };
}
