// Deterministic, shadow-only crypto score. This is deliberately separate from
// the equity dimensions: crypto has no earnings/P-E/insider substitute and no
// input is silently neutralized. A missing required input refuses the score.

export type CryptoScoreInput = {
  trendScore: number | null;
  structureScore: number | null;
  volatilityScore: number | null;
  spreadPct: number | null;
  quoteAgeSeconds: number | null;
  maxSpreadPct: number;
  maxQuoteAgeSeconds: number;
};

export type CryptoScoreResult =
  | { ok: true; score: number; components: { trend: number; structure: number; volatility: number }; version: "crypto-score-shadow-v1" }
  | { ok: false; reason: string; version: "crypto-score-shadow-v1" };

const VERSION = "crypto-score-shadow-v1" as const;

function validScore(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Produces a reproducible ranking signal only. Liquidity is a hard admissibility
 * check, never a positive score that could compensate for an excessive spread.
 */
export function scoreCryptoShadow(input: CryptoScoreInput): CryptoScoreResult {
  if (!validScore(input.trendScore) || !validScore(input.structureScore) || !validScore(input.volatilityScore)) {
    return { ok: false, reason: "missing_or_invalid_score_component", version: VERSION };
  }
  if (input.spreadPct == null || !Number.isFinite(input.spreadPct) || input.spreadPct < 0) {
    return { ok: false, reason: "missing_or_invalid_spread", version: VERSION };
  }
  if (input.quoteAgeSeconds == null || !Number.isFinite(input.quoteAgeSeconds) || input.quoteAgeSeconds < 0) {
    return { ok: false, reason: "missing_or_invalid_quote_age", version: VERSION };
  }
  if (input.spreadPct > input.maxSpreadPct) return { ok: false, reason: "spread_exceeds_policy", version: VERSION };
  if (input.quoteAgeSeconds > input.maxQuoteAgeSeconds) return { ok: false, reason: "quote_stale", version: VERSION };

  // Trend and market structure each describe directional evidence; volatility
  // rewards controlled, tradeable movement rather than raw magnitude.
  const score = input.trendScore * 0.4 + input.structureScore * 0.35 + input.volatilityScore * 0.25;
  return {
    ok: true,
    score: Math.round(score * 100) / 100,
    components: { trend: input.trendScore, structure: input.structureScore, volatility: input.volatilityScore },
    version: VERSION,
  };
}
