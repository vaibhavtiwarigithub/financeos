import { describe, expect, it } from "vitest";
import { evaluatePlanCalibration, summarizePlanCalibration } from "./plan-calibration";

const features = {
  trade_plan: {
    kind: "indicative_research_plan",
    status: "candidate",
    reference_price: 100,
    stop_loss_pct: 7,
    target_pct: 20,
    horizon_sessions: 10,
  },
};

describe("plan calibration", () => {
  it("compares a candidate policy level with its exact-horizon realized path", () => {
    expect(evaluatePlanCalibration(features, {
      horizon_days: 10,
      fwd_return: 0.11,
      benchmark_neutral_return: 0.08,
      max_adverse_excursion: -0.04,
      max_favorable_excursion: 0.22,
    })).toMatchObject({
      horizonDays: 10,
      riskFloor: 93,
      profitObjective: 120,
      objectiveReached: true,
      stopBreached: false,
      objectiveReachRatio: 1.1,
    });
  });

  it("refuses a different label horizon or a non-candidate plan", () => {
    const label = {
      horizon_days: 5,
      fwd_return: 0.02,
      max_adverse_excursion: -0.01,
      max_favorable_excursion: 0.03,
    };
    expect(evaluatePlanCalibration(features, label)).toBeNull();
    expect(evaluatePlanCalibration({ trade_plan: { ...features.trade_plan, status: "holding_context" } }, {
      ...label, horizon_days: 10,
    })).toBeNull();
  });

  it("reports both touches without claiming path order", () => {
    const outcome = evaluatePlanCalibration(features, {
      horizon_days: 10,
      fwd_return: 0.03,
      max_adverse_excursion: -0.09,
      max_favorable_excursion: 0.25,
    });
    expect(outcome).toMatchObject({ objectiveReached: true, stopBreached: true });
  });

  it("keeps review and adjustment sample floors distinct", () => {
    const base = evaluatePlanCalibration(features, {
      horizon_days: 10,
      fwd_return: 0.03,
      benchmark_neutral_return: 0.01,
      max_adverse_excursion: -0.02,
      max_favorable_excursion: 0.10,
    })!;
    expect(summarizePlanCalibration(10, Array.from({ length: 20 }, () => base)))
      .toMatchObject({ reviewable: true, adjustmentReady: false, n: 20 });
    expect(summarizePlanCalibration(10, Array.from({ length: 60 }, () => base)))
      .toMatchObject({ reviewable: true, adjustmentReady: true, n: 60 });
  });
});
