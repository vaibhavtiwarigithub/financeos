import { describe, it, expect } from "vitest";
import { computeLabel, LABEL_COST_HAIRCUT, type LabelCandle } from "@/lib/learning/label-math";

// Hand-built 10-day candle fixture: entry at 100, rallies to a high of 115 on
// day 4, dips to a low of 96 on day 7, closes the 10-day window at 108.
const fixture: LabelCandle[] = [
  { date: "d1", close: 102, high: 103, low: 100 },
  { date: "d2", close: 104, high: 106, low: 101 },
  { date: "d3", close: 106, high: 108, low: 103 },
  { date: "d4", close: 112, high: 115, low: 110 }, // MFE day
  { date: "d5", close: 109, high: 112, low: 107 },
  { date: "d6", close: 103, high: 105, low: 99 },
  { date: "d7", close: 98, high: 100, low: 96 },  // MAE day
  { date: "d8", close: 101, high: 102, low: 97 },
  { date: "d9", close: 105, high: 106, low: 100 },
  { date: "d10", close: 108, high: 109, low: 104 }, // exit day
];

describe("computeLabel (fwd_return / MAE / MFE on a hand-built fixture)", () => {
  const ENTRY = 100;

  it("computes fwd_return as (exit-entry)/entry minus the cost haircut", () => {
    const label = computeLabel(ENTRY, fixture, 10);
    expect(label).not.toBeNull();
    const expected = (108 - 100) / 100 - LABEL_COST_HAIRCUT;
    expect(label!.fwdReturn).toBeCloseTo(expected, 6);
    expect(label!.exitPrice).toBe(108);
  });

  it("computes max_favorable_excursion as the best high over the window", () => {
    const label = computeLabel(ENTRY, fixture, 10);
    // best high = 115 on day 4 -> (115-100)/100 = 0.15
    expect(label!.maxFavorableExcursion).toBeCloseTo(0.15, 6);
  });

  it("computes max_adverse_excursion as the worst low over the window (always <= 0)", () => {
    const label = computeLabel(ENTRY, fixture, 10);
    // worst low = 96 on day 7 -> (96-100)/100 = -0.04
    expect(label!.maxAdverseExcursion).toBeCloseTo(-0.04, 6);
    expect(label!.maxAdverseExcursion).toBeLessThanOrEqual(0);
  });

  it("computes benchmark_neutral_return as fwd_return minus the benchmark return", () => {
    const label = computeLabel(ENTRY, fixture, 10, 0.02); // benchmark up 2%
    const expectedFwd = (108 - 100) / 100 - LABEL_COST_HAIRCUT;
    expect(label!.benchmarkNeutralReturn).toBeCloseTo(expectedFwd - 0.02, 6);
  });

  it("returns null benchmark_neutral_return when no benchmark is available", () => {
    const label = computeLabel(ENTRY, fixture, 10, null);
    expect(label!.benchmarkNeutralReturn).toBeNull();
  });

  it("returns null (not matured) when fewer candles than the horizon are available", () => {
    const label = computeLabel(ENTRY, fixture.slice(0, 5), 10);
    expect(label).toBeNull();
  });

  it("returns null for a non-positive entry price", () => {
    expect(computeLabel(0, fixture, 10)).toBeNull();
    expect(computeLabel(-5, fixture, 10)).toBeNull();
  });

  it("uses only the FIRST horizonDays candles even if more are provided (no future leakage)", () => {
    const extended = [...fixture, { date: "d11", close: 500, high: 600, low: 400 }];
    const label = computeLabel(ENTRY, extended, 10);
    // day 11's absurd values must not affect a 10-day label
    expect(label!.exitPrice).toBe(108);
    expect(label!.maxFavorableExcursion).toBeCloseTo(0.15, 6);
  });
});
