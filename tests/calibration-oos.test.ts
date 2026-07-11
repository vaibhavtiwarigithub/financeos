// Part of Test 4/§learning safety: the calibrated P(win) model must not reach the
// live sizing path unless its OUT-OF-SAMPLE (walk-forward holdout) calibration is
// verified. acceptCalibrationOOS is fail-closed: too few holdout rows, degenerate
// (all-one-class) outcomes, non-computable error, or ECE > 0.1 all reject.

import { describe, it, expect } from "vitest";
import { acceptCalibrationOOS } from "@/lib/validation/calibration";

// Build n predictions where the realized outcome is drawn deterministically to
// match the predicted probability (well-calibrated) or to diverge (mis-calibrated).
function preds(n: number, predicted: number, realizedRate: number) {
  // Spread wins EVENLY across the index (interleaved), not in a leading block —
  // reliabilityDeciles sorts by predicted, so a block of wins would land in the
  // low deciles and inflate ECE. Even spread keeps every decile at realizedRate.
  return Array.from({ length: n }, (_, i) => ({
    predicted,
    realized: (Math.round((i + 1) * realizedRate) - Math.round(i * realizedRate)) as 0 | 1,
  }));
}

describe("acceptCalibrationOOS — fail-closed gate", () => {
  it("rejects a holdout smaller than the minimum sample floor", () => {
    const r = acceptCalibrationOOS(preds(10, 0.5, 0.5));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/insufficient OOS samples/);
    expect(r.ece).toBeNull();
  });

  it("rejects a degenerate all-one-class holdout (no meaningful win rate)", () => {
    const allWins = Array.from({ length: 40 }, () => ({ predicted: 0.6, realized: 1 as const }));
    const r = acceptCalibrationOOS(allWins);
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/degenerate/);
  });

  it("rejects a well-populated but badly miscalibrated model (ECE too high)", () => {
    // Predict 0.9 everywhere but only ~50% actually win -> ECE ~0.4.
    const r = acceptCalibrationOOS(preds(100, 0.9, 0.5));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/calibration error too high/);
    expect(r.ece).toBeGreaterThan(0.1);
  });

  it("accepts a well-calibrated holdout with enough samples", () => {
    // Predict 0.5 everywhere, ~50% win -> ECE ~0.
    const r = acceptCalibrationOOS(preds(100, 0.5, 0.5));
    expect(r.accepted).toBe(true);
    expect(r.ece).not.toBeNull();
    expect(r.ece as number).toBeLessThanOrEqual(0.1);
    expect(r.nOOS).toBe(100);
  });

  it("sanitizes out-of-range predictions and non-binary outcomes before scoring", () => {
    const dirty = [
      ...preds(60, 0.5, 0.5),
      { predicted: 1.5, realized: 1 },   // out of range
      { predicted: NaN, realized: 0 },   // non-finite
      { predicted: 0.5, realized: 2 as any }, // non-binary
    ];
    const r = acceptCalibrationOOS(dirty as any);
    expect(r.nOOS).toBe(60); // only the clean rows counted
  });

  it("treats null/empty input as fail-closed, never accepted-by-default", () => {
    expect(acceptCalibrationOOS(null as any).accepted).toBe(false);
    expect(acceptCalibrationOOS([]).accepted).toBe(false);
  });
});
