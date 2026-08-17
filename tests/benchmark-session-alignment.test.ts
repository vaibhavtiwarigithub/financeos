// W5 detectors.
//
// Production defect being locked out: `bench_nav` 708.42 is VOO's 2026-08-11
// close, and it is stored under BOTH 2026-08-12 and 2026-08-13, because both
// writers accepted any positive benchmark quote and labelled it with the cron's
// run date. These tests fail if any of that behaviour comes back.

import { describe, expect, it } from "vitest";
import {
  benchmarkReturnPct,
  benchmarkSymbol,
  selectBenchmarkObservation,
} from "@/lib/paper/benchmark-observation";

const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close, volume: 1 });

// Dates are relative to now, not literals: the daily-bar recency guard is
// wall-clock, so a pinned 2026-08 fixture would silently start failing for the
// wrong reason a week later.
const dayOffset = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const TODAY = dayOffset(0);
const PREV = dayOffset(1);
const PREV2 = dayOffset(2);

// The incident shape: the newest available close is the PREVIOUS session, and
// the writer wanted to stamp it with today's (and then tomorrow's) run date.
// Real numbers: VOO 708.42 was the 2026-08-11 close, stored under 08-12 AND 08-13.
const VOO = [bar(PREV2, 706.55), bar(PREV, 708.42)];

describe("a benchmark observation carries its own session", () => {
  it("returns the bar for the requested session, dated by the bar", () => {
    const r = selectBenchmarkObservation(VOO, "VOO", "yahoo", PREV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.observation).toEqual({ symbol: "VOO", sessionDate: PREV, close: 708.42, source: "yahoo" });
  });

  // THE detector: the exact production defect.
  it("REFUSES to stamp the previous session's close with today's run date", () => {
    const r = selectBenchmarkObservation(VOO, "VOO", "yahoo", TODAY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("benchmark_session_mismatch");
    expect(r.latestSessionDate).toBe(PREV);
    expect(r.detail).toContain(`refusing to store it under ${TODAY}`);
  });

  it("REFUSES it again on the next run rather than repeating the same close", () => {
    const r = selectBenchmarkObservation(VOO, "VOO", "yahoo", dayOffset(-1));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("benchmark_session_mismatch");
  });

  it("never infers the observation date from the run date", () => {
    const r = selectBenchmarkObservation(VOO, "VOO", "yahoo", PREV2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The older bar, not the newest one.
    expect(r.observation.sessionDate).toBe(PREV2);
    expect(r.observation.close).toBe(706.55);
  });

  it("rejects an empty or unusable bar series rather than inventing a level", () => {
    expect(selectBenchmarkObservation([], "VOO", "unavailable", TODAY).ok).toBe(false);
    const junk = [{ date: TODAY, open: 0, high: 0, low: 0, close: 0, volume: 0 }];
    const r = selectBenchmarkObservation(junk, "VOO", "yahoo", TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("benchmark_bars_unavailable");
  });

  it("names a provider stranded in the past as stale, not merely mismatched", () => {
    const stale = [bar("2020-01-02", 300), bar("2020-01-03", 301)];
    const r = selectBenchmarkObservation(stale, "VOO", "yahoo", TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("benchmark_bars_stale");
  });

  it("resolves today's bar when it exists", () => {
    const r = selectBenchmarkObservation([bar(TODAY, 712.34)], "VOO", "yahoo", TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.observation.sessionDate).toBe(TODAY);
  });

  it("keeps the per-market benchmark symbols", () => {
    expect(benchmarkSymbol("us")).toBe("VOO");
    expect(benchmarkSymbol("india")).toBe("^NSEI");
  });
});

describe("benchmark return baseline", () => {
  it("computes vs the first recorded observation", () => {
    expect(benchmarkReturnPct(110, 100)).toBeCloseTo(10, 10);
  });

  it("returns null rather than a fake 0% when there is no baseline", () => {
    expect(benchmarkReturnPct(110, null)).toBeNull();
    expect(benchmarkReturnPct(110, 0)).toBeNull();
  });
});
