import { describe, expect, it } from "vitest";
import { bindTradePrices, buildExecutionRiskPlanProvenance, buildIndicativeTradePlan, resolveExecutionRiskReward } from "@/lib/trading/trade-plan";

describe("research-time indicative trade plan", () => {
  it("builds native-currency candidate levels from the research reference", () => {
    const plan = buildIndicativeTradePlan({
      referencePrice: 100, referenceAsOf: "2026-07-20", decisionAt: "2026-07-20T14:00:00Z", referenceSource: "massive", currency: "USD",
      stopLossPct: 7, targetPct: 20, horizonSessions: 10, mandateVersion: 3,
      entryEligible: true, direction: "long", isHeld: false,
    });
    expect(plan).toMatchObject({
      status: "candidate", currency: "USD", reference_price: 100,
      initial_risk_floor: 93, profit_objective: 120, executable: false,
    });
  });

  it("never presents entry levels for rejected or held symbols", () => {
    const common = {
      referencePrice: 100, referenceAsOf: "2026-07-20", decisionAt: "2026-07-20T14:00:00Z", referenceSource: "upstox", currency: "INR" as const,
      stopLossPct: 7, targetPct: 20, horizonSessions: 10, mandateVersion: 1, direction: "long",
    };
    expect(buildIndicativeTradePlan({ ...common, entryEligible: false, isHeld: false })).toMatchObject({
      status: "no_entry", initial_risk_floor: null, profit_objective: null,
    });
    expect(buildIndicativeTradePlan({ ...common, entryEligible: true, isHeld: true })).toMatchObject({
      status: "holding_context", initial_risk_floor: null, profit_objective: null,
    });
  });

  it("fails honestly when the research reference is invalid", () => {
    expect(buildIndicativeTradePlan({
      referencePrice: Number.NaN, referenceAsOf: "2026-07-20", decisionAt: "2026-07-20T14:00:00Z", currency: "USD", stopLossPct: 7, targetPct: 20,
      horizonSessions: 10, mandateVersion: 1, entryEligible: true, direction: "long", isHeld: false,
    })).toMatchObject({ status: "unavailable", reference_price: null, initial_risk_floor: null, profit_objective: null });
  });

  it("keeps a stale close for audit but does not create levels from it", () => {
    expect(buildIndicativeTradePlan({
      referencePrice: 100, referenceAsOf: "2026-06-01", decisionAt: "2026-07-20T14:00:00Z",
      currency: "USD", stopLossPct: 7, targetPct: 20, horizonSessions: 10,
      mandateVersion: 1, entryEligible: true, direction: "long", isHeld: false,
    })).toMatchObject({
      status: "unavailable", reference_price: 100, reference_fresh: false,
      initial_risk_floor: null, profit_objective: null,
    });
  });
});

describe("fill-time risk/return binding", () => {
  it("uses valid learned MAE/MFE and applies the approved bounds", () => {
    const policy = resolveExecutionRiskReward({
      mandateStopLossPct: 7, mandateTargetPct: 20,
      learned: { stopMaePctile: -0.18, targetMfePctile: 0.65, n: 80 },
    });
    expect(policy).toEqual({ stopLossPct: 10, targetPct: 40, source: "ledger_percentile", sampleSize: 80 });
    expect(bindTradePrices(250, policy)).toEqual({ stopLoss: 225, priceTarget: 350 });
  });

  it("falls back to the mandate for thin or malformed learned data", () => {
    expect(resolveExecutionRiskReward({
      mandateStopLossPct: 5, mandateTargetPct: 12,
      learned: { stopMaePctile: -0.04, targetMfePctile: 0.15, n: 59 },
    })).toEqual({ stopLossPct: 5, targetPct: 12, source: "mandate", sampleSize: null });
    expect(resolveExecutionRiskReward({
      mandateStopLossPct: 5, mandateTargetPct: 12,
      learned: { stopMaePctile: 0.04, targetMfePctile: -0.15, n: 80 },
    }).source).toBe("mandate");
  });

  it("preserves mandate geometry without inventing a larger reward", () => {
    const policy = resolveExecutionRiskReward({ mandateStopLossPct: 7, mandateTargetPct: 8 });
    expect(policy).toMatchObject({ stopLossPct: 7, targetPct: 8, source: "mandate" });
    expect(resolveExecutionRiskReward({ mandateStopLossPct: 30, mandateTargetPct: 80 }))
      .toMatchObject({ stopLossPct: 30, targetPct: 80 });
  });

  it("refuses to bind non-positive or non-finite fills", () => {
    const policy = resolveExecutionRiskReward({ mandateStopLossPct: 7, mandateTargetPct: 20 });
    expect(bindTradePrices(0, policy)).toBeNull();
    expect(bindTradePrices(Number.NaN, policy)).toBeNull();
  });

  it("records the exact ledger inputs rather than a label that cannot be reproduced", () => {
    const learned = { stopMaePctile: -0.0534, targetMfePctile: 0.0345, n: 134 };
    const riskReward = resolveExecutionRiskReward({ mandateStopLossPct: 7, mandateTargetPct: 8, learned });
    const provenance = buildExecutionRiskPlanProvenance({
      market: "india", observedAt: "2026-09-12T12:00:00.000Z", resolvedHorizonDays: 10,
      mandate: { version: 3, stopLossPct: 7, targetPct: 8 }, riskReward, learned,
    });
    expect(provenance).toMatchObject({
      version: "v1", market: "india", resolved_horizon_days: 10,
      resolved: { source: "ledger_percentile", stop_loss_pct: 5.34, target_pct: 3.45, sample_size: 134 },
      ledger_percentile: { stop_mae_pctile: -0.0534, target_mfe_pctile: 0.0345, stop_percentile: 0.25, target_percentile: 0.75 },
    });
  });

  it("does not manufacture ledger provenance after a mandate fallback", () => {
    const riskReward = resolveExecutionRiskReward({
      mandateStopLossPct: 7, mandateTargetPct: 8,
      learned: { stopMaePctile: -0.04, targetMfePctile: 0.03, n: 59 },
    });
    const provenance = buildExecutionRiskPlanProvenance({
      market: "us", observedAt: "2026-09-12T12:00:00.000Z", resolvedHorizonDays: 10,
      mandate: { version: 4, stopLossPct: 7, targetPct: 8 }, riskReward,
      learned: { stopMaePctile: -0.04, targetMfePctile: 0.03 },
    });
    expect(provenance.resolved.source).toBe("mandate");
    expect(provenance.ledger_percentile).toBeNull();
  });
});
