import { describe, it, expect } from "vitest";
import { walkForwardFolds, type LabeledObservation } from "@/lib/learning/dataset";

const DAY = 86400_000;

/**
 * Weekday-only sessions, which is what a real market calendar looks like.
 *
 * THE OLD FIXTURE'S DEFECT: it emitted one row per CONSECUTIVE CALENDAR DAY,
 * weekends included, so calendar days and market sessions were identical by
 * construction. That is the same assumption the implementation bug made, so the
 * test could never fail on it. A purge expressed in calendar days is only
 * correct when no weekend exists.
 */
function tradingSessions(count: number, startUtcDay = 3): string[] {
  const out: string[] = [];
  let d = startUtcDay;
  while (out.length < count) {
    const date = new Date(d * DAY);
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(date.toISOString());
    d++;
  }
  return out;
}

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
    availability_mask: null,
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

describe("walkForwardFolds — purge is counted in SESSIONS, not calendar days", () => {
  // THE REGRESSION THIS EXISTS FOR (2026-09-01). The implementation computed
  // purgeCutoffMs = testStart - horizonDays * 86400_000. Over a real calendar a
  // nominal 10-day purge spans only ~6-7 trading sessions, so training rows whose
  // 10-SESSION label windows still reached into the test window survived the
  // purge and leaked the future.
  const sessions = tradingSessions(160);
  const rows = sessions.map((ts, i) => makeRow(i, { ts }));

  it("leaves exactly horizonSessions of sessions between train end and test start", () => {
    const folds = walkForwardFolds(rows, {
      folds: 4, testSessions: 20, horizonSessions: 10, embargoSessions: 10,
    });
    expect(folds.length).toBeGreaterThan(0);

    const index = new Map(sessions.map((ts, i) => [ts.slice(0, 10), i]));
    for (const fold of folds) {
      const lastTrainIdx = Math.max(...fold.train.map(r => index.get(r.ts.slice(0, 10))!));
      const firstTestIdx = Math.min(...fold.test.map(r => index.get(r.ts.slice(0, 10))!));
      // A train row at index i has a label window ending at i + 10 SESSIONS.
      // That must not reach the first test session.
      expect(lastTrainIdx + 10).toBeLessThanOrEqual(firstTestIdx);
    }
  });

  it("purges MORE rows than a calendar-day purge would have", () => {
    // A calendar-day purge of 10 days covers ~6 sessions across weekends, so the
    // correct session purge must exclude strictly more training rows.
    const folds = walkForwardFolds(rows, {
      folds: 1, testSessions: 20, horizonSessions: 10, embargoSessions: 10,
    });
    expect(folds).toHaveLength(1);

    const index = new Map(sessions.map((ts, i) => [ts.slice(0, 10), i]));
    const firstTestIdx = Math.min(...folds[0].test.map(r => index.get(r.ts.slice(0, 10))!));
    const lastTrainIdx = Math.max(...folds[0].train.map(r => index.get(r.ts.slice(0, 10))!));
    const gapSessions = firstTestIdx - lastTrainIdx;

    // Exactly the horizon, not the ~6 sessions a calendar-day purge would leave.
    expect(gapSessions).toBeGreaterThanOrEqual(10);
    expect(gapSessions).toBeLessThan(14);
  });

  it("embargo advances the next test window by sessions, not calendar days", () => {
    const folds = walkForwardFolds(rows, {
      folds: 3, testSessions: 20, horizonSessions: 10, embargoSessions: 10,
    });
    const index = new Map(sessions.map((ts, i) => [ts.slice(0, 10), i]));
    for (let f = 1; f < folds.length; f++) {
      const prevTestLast = Math.max(...folds[f - 1].test.map(r => index.get(r.ts.slice(0, 10))!));
      const nextTestFirst = Math.min(...folds[f].test.map(r => index.get(r.ts.slice(0, 10))!));
      expect(nextTestFirst - prevTestLast).toBeGreaterThanOrEqual(10);
    }
  });

  it("treats the legacy *Days option names as sessions", () => {
    // The old names always MEANT sessions; only the arithmetic was wrong. They
    // must keep working so existing callers are not silently reinterpreted.
    const viaLegacy = walkForwardFolds(rows, { folds: 2, testDays: 20, horizonDays: 10, embargoDays: 10 });
    const viaNew = walkForwardFolds(rows, { folds: 2, testSessions: 20, horizonSessions: 10, embargoSessions: 10 });
    expect(viaLegacy.map(f => f.trainEnd)).toEqual(viaNew.map(f => f.trainEnd));
    expect(viaLegacy.map(f => f.test.length)).toEqual(viaNew.map(f => f.test.length));
  });

  it("handles holiday gaps without a separate calendar source", () => {
    // Drop 3 consecutive sessions to simulate a market holiday week.
    const withHoliday = rows.filter((_, i) => i < 40 || i > 42);
    const folds = walkForwardFolds(withHoliday, {
      folds: 2, testSessions: 20, horizonSessions: 10, embargoSessions: 10,
    });
    const present = withHoliday.map(r => r.ts.slice(0, 10));
    const index = new Map(present.map((d, i) => [d, i]));
    for (const fold of folds) {
      const lastTrainIdx = Math.max(...fold.train.map(r => index.get(r.ts.slice(0, 10))!));
      const firstTestIdx = Math.min(...fold.test.map(r => index.get(r.ts.slice(0, 10))!));
      expect(lastTrainIdx + 10).toBeLessThanOrEqual(firstTestIdx);
    }
  });
});
