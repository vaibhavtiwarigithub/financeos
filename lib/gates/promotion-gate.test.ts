import { describe, it, expect } from "vitest";
import { evaluateGate } from "./promotion-gate";

// A clean-passing edge: IC well above floor, strong t-stats, no decay, 1 trial.
const PASSING = { ics: [0.05, 0.055, 0.06], tStats: [2.4, 2.6, 2.8], trialsRun: 1 };

describe("evaluateGate", () => {
  it("passes a strong, stable edge", () => {
    const r = evaluateGate(PASSING);
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.sample_n).toBe(3);
    expect(r.walk_forward_pass).toBe(true);
    expect(r.dsr_z).toBeCloseTo(2.8, 5); // trialsRun=1 → no DSR penalty
  });

  it("rejects fewer than 3 IC windows without evaluating other gates", () => {
    const r = evaluateGate({ ics: [0.05, 0.06], tStats: [3, 3], trialsRun: 1 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual(["insufficient_windows:2<3"]);
    expect(r.t_stat_best).toBeNull();
  });

  it("rejects when latest IC is below the floor", () => {
    const r = evaluateGate({ ...PASSING, ics: [0.05, 0.04, 0.01] });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("ic_below_floor"))).toBe(true);
  });

  it("rejects when the best t-stat misses the hurdle", () => {
    const r = evaluateGate({ ...PASSING, tStats: [1.2, 1.5, 1.9] });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("t_stat_below_hurdle"))).toBe(true);
  });

  it("deflates the t-stat as variant count rises", () => {
    const at1 = evaluateGate({ ...PASSING, tStats: [2.4, 2.4, 2.4], trialsRun: 1 });
    const at20 = evaluateGate({ ...PASSING, tStats: [2.4, 2.4, 2.4], trialsRun: 20 });
    expect(at1.dsr_z).toBeCloseTo(2.4, 5);        // S=1 → no penalty
    expect(at20.dsr_z).toBeCloseTo(2.4 - 1.96, 2); // S=20 → E[max t] ≈ 1.96
    expect(at20.dsr_z! < at1.dsr_z!).toBe(true);
  });

  it("fails DSR when the penalty exceeds the best t-stat", () => {
    // Needs S > ~22 for E[max t] to clear the 2.0 hurdle, so this only bites
    // above the schema's variant_budget ceiling of 20 — see note in the route.
    const r = evaluateGate({ ...PASSING, tStats: [2.0, 2.1, 2.1], trialsRun: 200 });
    expect(r.pass).toBe(false);
    expect(r.dsr_z! < 0).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("dsr_failed"))).toBe(true);
  });

  it("rejects a walk-forward decay of more than 50%", () => {
    const r = evaluateGate({ ...PASSING, ics: [0.10, 0.07, 0.04] });
    expect(r.pass).toBe(false);
    expect(r.walk_forward_pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("walk_forward_failed"))).toBe(true);
  });
});
