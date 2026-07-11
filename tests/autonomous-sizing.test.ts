// Tests 11 & 12 (fix-prompt §Required tests):
//  - Test 11: a stale NAV or a stale/absent quote must NOT enter or size a
//    position — the autonomous money path fails closed, never uses a fallback.
//  - Test 12: US and India caps must not cross-contaminate. The per-order cap is
//    USD-denominated; applying it to an INR-NAV India order divides USD/INR and
//    produces a wrong dimensionless ratio, so India MUST skip the USD cap.

import { describe, it, expect } from "vitest";
import { computeAutonomousSizing, type SizingInput, type LiveAutoPolicy } from "@/lib/trading/execution-kernel";

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
  return {
    nav: 10_000,
    nav_captured_at: new Date().toISOString(),
    current_price: 100,
    price_stale: false,
    win_rate: null,
    payoff_ratio: null,
    flat_size_pct: 10,
    policy: policy(),
    market: "us",
    ...over,
  };
}

describe("computeAutonomousSizing — fail-closed on stale/absent inputs (Test 11)", () => {
  it("refuses when NAV is missing, zero, or non-finite (no fallback NAV)", () => {
    expect(computeAutonomousSizing(sizing({ nav: 0 })).ok).toBe(false);
    expect(computeAutonomousSizing(sizing({ nav: NaN })).reject_reason).toBe("no_live_nav");
    expect(computeAutonomousSizing(sizing({ nav: -5 })).ok).toBe(false);
  });

  it("refuses when NAV is older than the strict max age", () => {
    const old = new Date(Date.now() - 6 * 3_600_000).toISOString(); // 6h > 4h default
    const r = computeAutonomousSizing(sizing({ nav_captured_at: old }));
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toMatch(/^stale_nav_/);
  });

  it("refuses when the quote is stale or non-positive (no stale-price sizing)", () => {
    expect(computeAutonomousSizing(sizing({ price_stale: true })).reject_reason).toBe("no_current_price");
    expect(computeAutonomousSizing(sizing({ current_price: 0 })).reject_reason).toBe("no_current_price");
    expect(computeAutonomousSizing(sizing({ current_price: NaN })).ok).toBe(false);
  });

  it("refuses when the computed quantity rounds below one share", () => {
    // nav 10k * 10% = $1000 notional, price $2000 -> 0 shares
    const r = computeAutonomousSizing(sizing({ current_price: 2000 }));
    expect(r.ok).toBe(false);
    expect(r.reject_reason).toBe("qty_rounds_to_zero");
  });

  it("sizes a valid US order with fresh NAV + quote", () => {
    const r = computeAutonomousSizing(sizing());
    expect(r.ok).toBe(true);
    expect(r.proposed_qty).toBeGreaterThanOrEqual(1);
    expect(r.estimated_notional).toBeGreaterThan(0);
  });
});

describe("computeAutonomousSizing — US/India cap isolation (Test 12)", () => {
  it("applies the USD per-order cap on a US order (clamps size down)", () => {
    // Binding cap: $200 of a $10k NAV = 2% max, well under the 10% flat size.
    const r = computeAutonomousSizing(sizing({
      market: "us",
      policy: policy({ live_auto_max_per_order_usd: 200 }),
    }));
    expect(r.ok).toBe(true);
    // clamped to 200/10000 = 0.02 -> $200 notional, 2 shares @ $100
    expect(r.estimated_notional).toBeLessThanOrEqual(200);
  });

  it("does NOT apply the USD per-order cap on an India order (no USD→INR mixing)", () => {
    const usdCap = policy({ live_auto_max_per_order_usd: 200 });
    const us = computeAutonomousSizing(sizing({ market: "us", policy: usdCap }));
    const india = computeAutonomousSizing(sizing({ market: "india", policy: usdCap }));
    expect(us.ok).toBe(true);
    expect(india.ok).toBe(true);
    // India ignores the USD cap -> full 10% flat size ($1000) vs US clamped to $200.
    expect(india.estimated_notional).toBeGreaterThan(us.estimated_notional);
    expect(india.size_pct).toBeGreaterThan(us.size_pct);
  });

  it("India Kelly sizing is also not clamped by the USD cap", () => {
    const r = computeAutonomousSizing(sizing({
      market: "india",
      win_rate: 0.6,
      payoff_ratio: 2,
      policy: policy({ live_auto_max_per_order_usd: 50 }), // tiny USD cap must be ignored
    }));
    expect(r.ok).toBe(true);
    // A $50 cap on a $10k NAV would force <1% if applied. India must not apply it.
    expect(r.size_pct).toBeGreaterThan(50 / 10_000);
  });
});
