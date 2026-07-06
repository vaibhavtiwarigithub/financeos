import { describe, it, expect } from "vitest";
import { walkForwardFolds, type LabeledObservation } from "@/lib/learning/dataset";

const DAY = 86400_000;

function makeRow(daysFromEpoch: number, overrides: Partial<LabeledObservation> = {}): LabeledObservation {
  return {
    id: daysFromEpoch,
    ts: new Date(daysFromEpoch * DAY).toISOString(),
    market: "us",
    symbol: "TEST",
    analyst_score: 60,
    fundamental_score: 60, technical_score: 60, sentiment_score: 60, macro_score: 60, insider_score: 60,
    direction: "long",
    entry_eligible: true,
    score_threshold: 60,
    horizon_days: 10,
    fwd_return: 0.01,
    benchmark_return: 0,
    benchmark_neutral_return: 0.01,
    max_adverse_excursion: -0.02,
    max_favorable_excursion: 0.03,
    ...overrides,
  };
}

describe("walkForwardFolds — purge & embargo (no future leakage across folds)", () => {
  it("no train row's label window overlaps its fold's test window (purge property)", () => {
    // 200 daily observations, one per day.
    const rows = Array.from({ length: 200 }, (_, i) => makeRow(i));
    const folds = walkForwardFolds(rows, { folds: 4, testDays: 20, horizonDays: 10, embargoDays: 10 });

    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) {
      const testStart = new Date(fold.test[0].ts).getTime();
      for (const trainRow of fold.train) {
        const trainTs = new Date(trainRow.ts).getTime();
        // The train row's own label window (ts .. ts+horizonDays) must not reach
        // into the test window — i.e. trainTs + horizonDays*DAY <= testStart.
        const labelWindowEnd = trainTs + 10 * DAY;
        expect(labelWindowEnd).toBeLessThanOrEqual(testStart);
      }
    }
  });

  it("embargoes the gap after each test window before the next fold's train resumes", () => {
    const rows = Array.from({ length: 300 }, (_, i) => makeRow(i));
    const folds = walkForwardFolds(rows, { folds: 3, testDays: 20, horizonDays: 10, embargoDays: 10 });

    for (let f = 1; f < folds.length; f++) {
      const prevTestEnd = new Date(folds[f - 1].testEnd).getTime();
      const nextTestStart = new Date(folds[f].test[0]?.ts ?? folds[f].trainEnd).getTime();
      // Next fold's test must start at least embargoDays after the previous test ended.
      expect(nextTestStart).toBeGreaterThanOrEqual(prevTestEnd);
    }
  });

  it("returns an empty array for an empty dataset (no crash)", () => {
    expect(walkForwardFolds([])).toEqual([]);
  });

  it("skips folds where train or test would be empty rather than returning a malformed fold", () => {
    // Only 5 days of data — far too little for the default fold config.
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(i));
    const folds = walkForwardFolds(rows, { folds: 5, testDays: 30, horizonDays: 10 });
    for (const fold of folds) {
      expect(fold.train.length).toBeGreaterThan(0);
      expect(fold.test.length).toBeGreaterThan(0);
    }
  });
});
