import { describe, expect, it } from "vitest";
import { computeCryptoGeometry } from "./crypto-exit-geometry";

const base = {
  entryPrice: 100, atrPct: 4, structuralStopPct: 5, riskBudgetPct: 1,
  nav: 10_000, maxNotionalPct: 20, atrStopMultiple: 1.5, minStopPct: 3,
  maxStopPct: 10, rewardRiskMultiple: 2.5, expectedRoundTripCostPct: 0.4,
  minNetRewardRisk: 1.5,
};

describe("computeCryptoGeometry", () => {
  it("uses the wider structural/volatility stop and caps notional", () => {
    const result = computeCryptoGeometry(base);
    expect(result).toMatchObject({ ok: true, stopPct: 6, stopLoss: 94, priceTarget: 115, maxNotional: 2000, proposedNotional: 1562.5 });
  });

  it("refuses an unbounded-loss geometry", () => {
    expect(computeCryptoGeometry({ ...base, atrPct: 8, atrStopMultiple: 2 })).toMatchObject({ ok: false, reason: "stop_exceeds_max_loss_policy" });
  });

  it("refuses an attractive-looking target when costs erase its net reward", () => {
    expect(computeCryptoGeometry({ ...base, rewardRiskMultiple: 1, expectedRoundTripCostPct: 2 })).toMatchObject({ ok: false, reason: "net_reward_risk_below_policy" });
  });
});
