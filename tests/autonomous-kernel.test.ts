// Test 4 (fix-prompt §Required tests): the autonomous execution kernel must fail
// closed at every gate — deployment flag, DB toggle, expired lease, wrong
// direction (autonomous entries are long-only), score, confidence floor, caps.
// Also asserts the autonomy-ladder helpers (L3 allows owner clicks but NOT
// autonomous placement; L4 required for the autonomous_worker actor).
//
// AUTONOMOUS_LIVE_ENABLED is read once at module-eval, so gate tests below the
// deployment flag stub the env true and re-import a fresh kernel module.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { LiveAutoPolicy, KernelInput } from "@/lib/trading/execution-kernel";
import { liveOrdersAllowed, autonomousWorkerAllowed } from "@/lib/autonomy";

function policy(over: Partial<LiveAutoPolicy> = {}): LiveAutoPolicy {
  return {
    live_auto_enabled: true,
    live_auto_enabled_until: null,
    live_auto_policy_version: 1,
    live_auto_daily_cap_usd: 1000,
    live_auto_max_per_order_usd: 500,
    live_auto_min_evidence_confidence: 0.6,
    live_auto_max_open_positions: 10,
    live_auto_max_orders_per_day: 5,
    ...over,
  };
}

function input(over: Partial<KernelInput> = {}): KernelInput {
  return {
    symbol: "AAPL",
    market: "us",
    direction: "long",
    score: 80,
    evidence_confidence: 0.9,
    score_threshold: 70,
    proposed_notional_usd: 100,
    policy: policy(),
    current_open_positions: 0,
    orders_placed_today: 0,
    ...over,
  };
}

async function loadKernel(enabled: boolean) {
  vi.resetModules();
  vi.stubEnv("AUTONOMOUS_LIVE_ENABLED", enabled ? "true" : "");
  return import("@/lib/trading/execution-kernel");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("autonomy ladder helpers", () => {
  it("L3 allows live orders (owner-approved); L2 and below block ALL live orders", () => {
    expect(liveOrdersAllowed("L3_live_manual")).toBe(true);
    expect(liveOrdersAllowed("L2_shadow")).toBe(false);
    expect(liveOrdersAllowed("L1_paper_auto")).toBe(false);
  });

  it("L3 does NOT authorise the autonomous_worker actor — only L4+ does", () => {
    expect(autonomousWorkerAllowed("L3_live_manual")).toBe(false);
    expect(autonomousWorkerAllowed("L4_live_small_auto")).toBe(true);
    expect(autonomousWorkerAllowed("L5_scaled_auto")).toBe(true);
  });

  it("unknown/null autonomy levels fail closed to the L3 default (never open things up)", () => {
    expect(autonomousWorkerAllowed(null)).toBe(false);      // treated as L3
    expect(autonomousWorkerAllowed("garbage")).toBe(false); // treated as L3
    expect(liveOrdersAllowed(undefined)).toBe(true);        // L3 default allows owner clicks
  });
});

describe("evaluateAutonomousExecution — fail-closed gate matrix", () => {
  it("blocks when the deployment flag is off, regardless of DB policy", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(false);
    const r = evaluateAutonomousExecution(input());
    expect(r.go).toBe(false);
    expect(r.gate_failed).toBe("deployment_flag_inactive");
  });

  it("blocks when live_auto_enabled=false in strategy_config", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    const r = evaluateAutonomousExecution(input({ policy: policy({ live_auto_enabled: false }) }));
    expect(r.go).toBe(false);
    expect(r.gate_failed).toBe("db_toggle_off");
  });

  it("blocks on an expired owner lease", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const r = evaluateAutonomousExecution(input({ policy: policy({ live_auto_enabled_until: past }) }));
    expect(r.go).toBe(false);
    expect(r.gate_failed).toBe("lease_expired");
  });

  it("blocks a non-long direction — autonomous new entries are long-only (no auto shorts/exits)", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    for (const dir of ["short", "sell", "exit"]) {
      const r = evaluateAutonomousExecution(input({ direction: dir }));
      expect(r.go).toBe(false);
      expect(r.gate_failed).toBe("non_long_direction");
    }
  });

  it("blocks a score below the strategy threshold", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    const r = evaluateAutonomousExecution(input({ score: 65, score_threshold: 70 }));
    expect(r.go).toBe(false);
    expect(r.gate_failed).toBe("score_below_threshold");
  });

  it("blocks evidence confidence below the floor", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    const r = evaluateAutonomousExecution(input({ evidence_confidence: 0.4 }));
    expect(r.go).toBe(false);
    expect(r.gate_failed).toBe("confidence_below_floor");
  });

  it("blocks when the open-position cap is already reached", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    const r = evaluateAutonomousExecution(input({ current_open_positions: 10, policy: policy({ live_auto_max_open_positions: 10 }) }));
    expect(r.go).toBe(false);
    expect(r.gate_failed).toBe("max_positions_reached");
  });

  it("blocks when the daily order cap is already reached", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    const r = evaluateAutonomousExecution(input({ orders_placed_today: 5, policy: policy({ live_auto_max_orders_per_day: 5 }) }));
    expect(r.go).toBe(false);
    expect(r.gate_failed).toBe("max_daily_orders_reached");
  });

  it("blocks a notional above the per-order cap", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    const r = evaluateAutonomousExecution(input({ proposed_notional_usd: 999, policy: policy({ live_auto_max_per_order_usd: 500 }) }));
    expect(r.go).toBe(false);
    expect(r.gate_failed).toBe("per_order_cap_exceeded");
  });

  it("passes only when EVERY gate is satisfied", async () => {
    const { evaluateAutonomousExecution } = await loadKernel(true);
    const r = evaluateAutonomousExecution(input());
    expect(r.go).toBe(true);
    expect(r.gate_failed).toBeNull();
    expect(r.shadow_status).toBe("queued_auto");
  });
});
