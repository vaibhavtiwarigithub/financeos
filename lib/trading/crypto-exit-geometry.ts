// Deterministic crypto exit geometry for shadow evaluation. It contains no
// broker call and cannot open, close, or resize a position by itself.

export type CryptoGeometryInput = {
  entryPrice: number;
  atrPct: number;
  structuralStopPct: number;
  riskBudgetPct: number;
  nav: number;
  maxNotionalPct: number;
  atrStopMultiple: number;
  minStopPct: number;
  maxStopPct: number;
  rewardRiskMultiple: number;
  expectedRoundTripCostPct: number;
  minNetRewardRisk: number;
};

export type CryptoGeometry =
  | {
    ok: true;
    version: "crypto-geometry-shadow-v1";
    stopLoss: number;
    priceTarget: number;
    stopPct: number;
    grossTargetPct: number;
    expectedRoundTripCostPct: number;
    expectedNetTargetPct: number;
    netRewardRisk: number;
    maxNotional: number;
    riskNotional: number;
    proposedNotional: number;
  }
  | { ok: false; version: "crypto-geometry-shadow-v1"; reason: string };

const VERSION = "crypto-geometry-shadow-v1" as const;
const positive = (value: number) => Number.isFinite(value) && value > 0;

/**
 * Resolves stop distance from a price-structure invalidation and current
 * volatility, then sizes from a fixed portfolio loss budget. A geometry is
 * refused if its expected after-cost reward cannot justify the risk.
 */
export function computeCryptoGeometry(input: CryptoGeometryInput): CryptoGeometry {
  const values = [
    input.entryPrice, input.atrPct, input.structuralStopPct, input.riskBudgetPct,
    input.nav, input.maxNotionalPct, input.atrStopMultiple, input.minStopPct,
    input.maxStopPct, input.rewardRiskMultiple,
  ];
  if (!values.every(positive) || !Number.isFinite(input.expectedRoundTripCostPct) || input.expectedRoundTripCostPct < 0) {
    return { ok: false, version: VERSION, reason: "invalid_geometry_input" };
  }
  if (input.minStopPct > input.maxStopPct) return { ok: false, version: VERSION, reason: "invalid_stop_bounds" };

  const stopPct = Math.max(input.minStopPct, input.structuralStopPct, input.atrPct * input.atrStopMultiple);
  if (stopPct > input.maxStopPct) return { ok: false, version: VERSION, reason: "stop_exceeds_max_loss_policy" };

  const grossTargetPct = stopPct * input.rewardRiskMultiple;
  const expectedNetTargetPct = grossTargetPct - input.expectedRoundTripCostPct;
  const netRewardRisk = expectedNetTargetPct / (stopPct + input.expectedRoundTripCostPct);
  if (!Number.isFinite(netRewardRisk) || netRewardRisk < input.minNetRewardRisk) {
    return { ok: false, version: VERSION, reason: "net_reward_risk_below_policy" };
  }

  const maxNotional = input.nav * (input.maxNotionalPct / 100);
  const riskNotional = input.nav * (input.riskBudgetPct / 100) / ((stopPct + input.expectedRoundTripCostPct) / 100);
  const proposedNotional = Math.min(maxNotional, riskNotional);
  if (!positive(proposedNotional)) return { ok: false, version: VERSION, reason: "non_positive_size" };

  return {
    ok: true,
    version: VERSION,
    stopLoss: Math.round(input.entryPrice * (1 - stopPct / 100) * 100) / 100,
    priceTarget: Math.round(input.entryPrice * (1 + grossTargetPct / 100) * 100) / 100,
    stopPct,
    grossTargetPct,
    expectedRoundTripCostPct: input.expectedRoundTripCostPct,
    expectedNetTargetPct,
    netRewardRisk,
    maxNotional,
    riskNotional,
    proposedNotional,
  };
}
