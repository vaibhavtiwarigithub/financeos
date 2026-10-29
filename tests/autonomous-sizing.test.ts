// The autonomous sizing kernel must fail closed unless a complete executable
// calibration matches market, setup, horizon and mandate. Recent trade counts
// and a configured flat size are never substitutes for that evidence.
import { describe, it, expect } from "vitest";
import { computeAutonomousSizing, type SizingInput, type LiveAutoPolicy } from "@/lib/trading/execution-kernel";
import { EXECUTABLE_SIZING_OUTCOME_CONTRACT } from "@/lib/validation/calibration";

function policy(over: Partial<LiveAutoPolicy> = {}): LiveAutoPolicy {
  return {
    live_auto_enabled: true,
    live_auto_enabled_until: null,
    live_auto_policy_version: 1,
    live_auto_daily_cap_usd: null,
    live_auto_max_per_order_usd: null,
    live_auto_min_evidence_confidence: null,
    live_auto_max_open_positions: null,
    live_auto_max_orders_per_day: null,
    ...over,
  };
}

function sizing(over: Partial<SizingInput> = {}): SizingInput {
  const market = over.market === "india" ? "india" : "us";
  const horizon = over.horizon_sessions ?? 10;
  const mandateVersion = over.mandate_version ?? 1;
  const setup = over.setup_type ?? "quality_momentum";
  return {
    nav: 10_000,
    nav_captured_at: new Date().toISOString(),
    current_price: 100,
    price_stale: false,
    setup_type: setup,
    horizon_sessions: horizon,
    mandate_version: mandateVersion,
    sizing_edge: {
      market,
      setup_type: setup,
      horizon_sessions: horizon,
      mandate_version: mandateVersion,
      fitted_at: new Date().toISOString(),
      dataset_hash: "synthetic-test-dataset-hash",
      p_win: 0.6,
      payoff_ratio: 2,
      calibration: {
        outcome_contract: EXECUTABLE_SIZING_OUTCOME_CONTRACT,
        horizon_sessions: horizon,
        mandate_version: mandateVersion,
        payoff_ratio: 2,
        validation: {
          accepted: true,
          oos_sample_count: 250,
          independent_horizon_blocks: 50,
          positive_outcomes: 20,
          negative_outcomes: 20,
        },
      },
    },
    policy: policy(),
    market,
    ...over,
  };
}

describe("computeAutonomousSizing — fail-closed evidence contract", () => {
  it("returns zero when calibration is missing", () => {
    const r = computeAutonomousSizing(sizing({ sizing_edge: null }));
    expect(r).toMatchObject({ ok: false, reject_reason: "unvalidated_edge", size_pct: 0, proposed_qty: 0, estimated_notional: 0 });
  });

  it("rejects a positive score without matching market/setup/horizon/mandate evidence", () => {
    const input = sizing();
    expect(computeAutonomousSizing(sizing({
      setup_type: "breakout",
      sizing_edge: input.sizing_edge,
    })).reject_reason).toBe("invalid_calibrated_edge");
    expect(computeAutonomousSizing(sizing({
      sizing_edge: { ...input.sizing_edge!, market: "india" },
    })).reject_reason).toBe("invalid_calibrated_edge");
  });

  it("rejects an artifact with insufficient validation evidence", () => {
    const valid = sizing().sizing_edge!;
    const r = computeAutonomousSizing(sizing({ sizing_edge: {
      ...valid,
      calibration: { ...valid.calibration as object, validation: { accepted: false, oos_sample_count: 8, independent_horizon_blocks: 2, positive_outcomes: 3, negative_outcomes: 5 } },
    } }));
    expect(r).toMatchObject({ ok: false, reject_reason: "invalid_calibrated_edge", proposed_qty: 0 });
  });

  it("rejects stale, future-dated or malformed artifacts", () => {
    const valid = sizing().sizing_edge!;
    expect(computeAutonomousSizing(sizing({ sizing_edge: { ...valid, fitted_at: new Date(Date.now() - 15 * 86_400_000).toISOString() } })).reject_reason)
      .toBe("stale_calibrated_edge");
    expect(computeAutonomousSizing(sizing({ sizing_edge: { ...valid, fitted_at: new Date(Date.now() + 60_000).toISOString() } })).reject_reason)
      .toBe("stale_calibrated_edge");
    expect(computeAutonomousSizing(sizing({ sizing_edge: { ...valid, dataset_hash: " " } })).reject_reason)
      .toBe("invalid_calibrated_edge");
  });

  it("returns zero for invalid or non-positive edge instead of using a flat fallback", () => {
    const valid = sizing().sizing_edge!;
    expect(computeAutonomousSizing(sizing({ sizing_edge: { ...valid, p_win: 1.2 } })).reject_reason)
      .toBe("invalid_calibrated_edge");
    expect(computeAutonomousSizing(sizing({ sizing_edge: { ...valid, p_win: 0.4, payoff_ratio: 1,
      calibration: { ...valid.calibration as object, payoff_ratio: 1 } } })).reject_reason)
      .toBe("non_positive_calibrated_edge");
  });
});

describe("computeAutonomousSizing — NAV, quote and currency caps", () => {
  it("refuses when NAV is missing, zero, or non-finite", () => {
    expect(computeAutonomousSizing(sizing({ nav: 0 })).ok).toBe(false);
    expect(computeAutonomousSizing(sizing({ nav: NaN })).reject_reason).toBe("no_live_nav");
    expect(computeAutonomousSizing(sizing({ nav: -5 })).ok).toBe(false);
  });

  it("refuses when NAV is older than the strict max age", () => {
    const old = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const r = computeAutonomousSizing(sizing({ nav_captured_at: old }));
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toMatch(/^stale_nav_/);
  });

  it("refuses when the quote is stale or non-positive", () => {
    expect(computeAutonomousSizing(sizing({ price_stale: true })).reject_reason).toBe("no_current_price");
    expect(computeAutonomousSizing(sizing({ current_price: 0 })).reject_reason).toBe("no_current_price");
    expect(computeAutonomousSizing(sizing({ current_price: NaN })).ok).toBe(false);
  });

  it("keeps an eligible US fractional quantity", () => {
    const r = computeAutonomousSizing(sizing({ current_price: 2000, market: "us" }));
    expect(r.ok).toBe(true);
    expect(r.proposed_qty).toBe(0.5);
  });

  it("still refuses an India quantity that rounds below one whole share", () => {
    const r = computeAutonomousSizing(sizing({ current_price: 2000, market: "india" }));
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toBe("qty_rounds_to_zero");
  });

  it("applies the USD per-order cap on a US order", () => {
    const r = computeAutonomousSizing(sizing({ market: "us", policy: policy({ live_auto_max_per_order_usd: 200 }) }));
    expect(r.ok).toBe(true);
    expect(r.estimated_notional).toBeLessThanOrEqual(200);
  });

  it("does not apply the USD cap to INR and preserves India whole-share sizing", () => {
    const usdCap = policy({ live_auto_max_per_order_usd: 200 });
    const us = computeAutonomousSizing(sizing({ market: "us", policy: usdCap }));
    const india = computeAutonomousSizing(sizing({ market: "india", policy: usdCap }));
    expect(us.ok).toBe(true);
    expect(india.ok).toBe(true);
    expect(india.estimated_notional).toBeGreaterThan(us.estimated_notional);
  });
});
