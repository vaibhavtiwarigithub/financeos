import { describe, expect, it } from "vitest";
import { paperExitEconomics } from "@/lib/trading/paper-exit-economics";

describe("paperExitEconomics", () => {
  it("separates target payoff from the minimum blended partial-target gain", () => {
    expect(paperExitEconomics({
      market: "us", heldQty: 10, entryPrice: 100, stopPrice: 95, targetPrice: 108,
    })).toEqual({
      targetReturnPct: 8,
      stopReturnPct: -5,
      rewardRiskRatio: 1.6,
      targetExitQty: 5,
      runnerQty: 5,
      targetExitWeight: 0.5,
      minimumGrossGainIfTargetHitsPct: 4,
    });
  });

  it("uses market-local whole-share sizing for an India runner", () => {
    const result = paperExitEconomics({
      market: "india", heldQty: 3, entryPrice: 100, stopPrice: 94, targetPrice: 112,
    });
    expect(result.targetExitQty).toBe(1);
    expect(result.runnerQty).toBe(2);
    expect(result.targetExitWeight).toBe(0.333333);
    expect(result.minimumGrossGainIfTargetHitsPct).toBe(4);
  });

  it("does not manufacture reward-to-risk when the trailing stop protects profit", () => {
    const result = paperExitEconomics({
      market: "us", heldQty: 2, entryPrice: 100, stopPrice: 102, targetPrice: 110,
    });
    expect(result.stopReturnPct).toBe(2);
    expect(result.rewardRiskRatio).toBeNull();
  });
});
