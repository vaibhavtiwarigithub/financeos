import { describe, expect, it } from "vitest";
import { assessPaperTopUp } from "@/lib/trading/paper-topup-policy";

describe("paper add-to-winner policy", () => {
  it("allows a profitable addition only inside the active stop and target", () => {
    expect(assessPaperTopUp({ fillPrice: 112, weightedAverageCost: 100, activeStop: 105, activeTarget: 120 }))
      .toEqual({ allowed: true, activeStop: 105, activeTarget: 120 });
  });

  it("refuses averaging down or a fill on/below weighted cost", () => {
    expect(assessPaperTopUp({ fillPrice: 99, weightedAverageCost: 100 })).toEqual({
      allowed: false, reason: "top_up_not_above_weighted_cost",
    });
    expect(assessPaperTopUp({ fillPrice: 100, weightedAverageCost: 100 })).toEqual({
      allowed: false, reason: "top_up_not_above_weighted_cost",
    });
  });

  it("never adds at a triggered stop/target or more than once per session", () => {
    expect(assessPaperTopUp({ fillPrice: 105, weightedAverageCost: 100, activeStop: 105 }).allowed).toBe(false);
    expect(assessPaperTopUp({ fillPrice: 120, weightedAverageCost: 100, activeTarget: 120 }).allowed).toBe(false);
    expect(assessPaperTopUp({ fillPrice: 112, weightedAverageCost: 100, fillsThisSession: 1 })).toEqual({
      allowed: false, reason: "top_up_already_filled_this_session",
    });
  });

  it("fails closed on missing or malformed cost/price", () => {
    expect(assessPaperTopUp({ fillPrice: 0, weightedAverageCost: 100 })).toEqual({
      allowed: false, reason: "top_up_invalid_weighted_cost",
    });
    expect(assessPaperTopUp({ fillPrice: 100, weightedAverageCost: Number.NaN })).toEqual({
      allowed: false, reason: "top_up_invalid_weighted_cost",
    });
  });
});
