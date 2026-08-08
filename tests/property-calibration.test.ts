import { describe, it, expect } from "vitest";
import {
  calibrationBlocker,
  MIN_MATURED_OUTCOMES,
  summarizeCalibration,
  type MaturedOutcome,
} from "@/lib/property/calibration";

function outcome(covered: boolean, absoluteError: number, baseValue = 100): MaturedOutcome {
  return { intervalCovered: covered, absoluteError, baseValue };
}

describe("summarizeCalibration — the floor refuses, it does not caveat", () => {
  it("withholds every rate below the floor while still reporting n", () => {
    // At n=3 a coverage rate can only read 0, 33, 67 or 100 percent. Printing
    // any of those next to a warning invites it to be quoted without one.
    const s = summarizeCalibration("austin", "price_index", [
      outcome(true, 1), outcome(true, 2), outcome(false, 3),
    ]);
    expect(s.n).toBe(3);
    expect(s.sufficient).toBe(false);
    expect(s.intervalCoveragePct).toBeNull();
    expect(s.meanAbsoluteError).toBeNull();
    expect(s.meanAbsolutePercentError).toBeNull();
  });

  it("reports rates once the floor is reached", () => {
    const outcomes = [
      ...Array.from({ length: 8 }, () => outcome(true, 2)),
      ...Array.from({ length: 2 }, () => outcome(false, 7)),
    ];
    const s = summarizeCalibration("austin", "price_index", outcomes);
    expect(s.n).toBe(MIN_MATURED_OUTCOMES);
    expect(s.sufficient).toBe(true);
    expect(s.intervalCoveragePct).toBeCloseTo(80);
    expect(s.meanAbsoluteError).toBeCloseTo((8 * 2 + 2 * 7) / 10);
    expect(s.meanAbsolutePercentError).toBeCloseTo(3);
  });

  it("one short of the floor still refuses", () => {
    const outcomes = Array.from({ length: MIN_MATURED_OUTCOMES - 1 }, () => outcome(true, 1));
    expect(summarizeCalibration("austin", "price_index", outcomes).intervalCoveragePct).toBeNull();
  });

  it("an empty cohort is n=0, not a divide-by-zero", () => {
    const s = summarizeCalibration("bengaluru", "price_index", []);
    expect(s.n).toBe(0);
    expect(s.intervalCoveragePct).toBeNull();
    expect(s.sufficient).toBe(false);
  });

  it("drops non-finite rows from n rather than propagating NaN", () => {
    const s = summarizeCalibration("austin", "mortgage_rate", [
      outcome(true, 1), { intervalCovered: true, absoluteError: NaN, baseValue: 100 },
      { intervalCovered: false, absoluteError: 1, baseValue: Infinity },
    ]);
    expect(s.n).toBe(1);
  });

  it("rejects a zero-centred property forecast from the calibration cohort", () => {
    const outcomes = Array.from({ length: MIN_MATURED_OUTCOMES }, () => outcome(true, 0.5, 0));
    const s = summarizeCalibration("austin", "mortgage_rate", outcomes);
    expect(s.n).toBe(0);
    expect(s.meanAbsoluteError).toBeNull();
    expect(s.meanAbsolutePercentError).toBeNull();
  });

  it("computes true MAPE as the mean of per-forecast percentage errors", () => {
    const outcomes = [
      ...Array.from({ length: 5 }, () => outcome(true, 10, 100)),
      ...Array.from({ length: 5 }, () => outcome(true, 10, 200)),
    ];
    const s = summarizeCalibration("austin", "price_index", outcomes);
    expect(s.meanAbsoluteError).toBe(10);
    expect(s.meanAbsolutePercentError).toBeCloseTo(7.5);
  });

  it("excludes negative errors rather than letting corrupt rows reduce MAE", () => {
    const outcomes = [
      ...Array.from({ length: 10 }, () => outcome(true, 2, 100)),
      outcome(true, -100, 100),
    ];
    const s = summarizeCalibration("austin", "price_index", outcomes);
    expect(s.n).toBe(10);
    expect(s.meanAbsoluteError).toBe(2);
  });
});

describe("calibrationBlocker", () => {
  it("distinguishes nothing-matured from not-enough-matured", () => {
    expect(calibrationBlocker(summarizeCalibration("a", "m", []))).toContain("No forecast has matured");
    const few = calibrationBlocker(summarizeCalibration("a", "m", [outcome(true, 1), outcome(true, 1)]));
    expect(few).toContain(`2 of ${MIN_MATURED_OUTCOMES}`);
    expect(few).toContain("withheld");
  });

  it("is silent once the cohort is scoreable", () => {
    const outcomes = Array.from({ length: MIN_MATURED_OUTCOMES }, () => outcome(true, 1));
    expect(calibrationBlocker(summarizeCalibration("a", "m", outcomes))).toBeNull();
  });
});
