import { describe, it, expect } from "vitest";
import { buildBenchmarkWindow, type BenchmarkSeriesRow } from "@/lib/analytics/benchmark-window";

/** 9 sessions of NAV. Benchmark coverage is supplied per-test. */
function rows(benchDates: Record<string, number | null>): BenchmarkSeriesRow[] {
  const navs: Record<string, number> = {
    "2026-08-19": 100, "2026-08-20": 100.2, "2026-08-21": 100.1,
    "2026-08-24": 100.01, "2026-08-25": 100.4, "2026-08-26": 100.8,
    "2026-08-27": 101.0, "2026-08-28": 101.4, "2026-08-31": 101.345,
  };
  return Object.entries(navs).map(([date, nav]) => ({
    date, nav, bench_nav: benchDates[date] ?? null,
  }));
}

const FULL = { "2026-08-19": 50, "2026-08-20": 50.1, "2026-08-21": 50.2, "2026-08-24": 50.3,
               "2026-08-25": 50.4, "2026-08-26": 50.5, "2026-08-27": 50.6, "2026-08-28": 50.7,
               "2026-08-31": 50.8 };
// XLK stopped updating on 08-24 in production.
const STALE = { "2026-08-19": 50, "2026-08-20": 50.1, "2026-08-21": 50.2, "2026-08-24": 50.3 };
// A benchmark whose history starts inside the window.
const LATE_START = { "2026-08-26": 60, "2026-08-27": 60.1, "2026-08-28": 60.2, "2026-08-31": 60.3 };

describe("portfolio return is benchmark-independent", () => {
  // THE REGRESSION THIS FILE EXISTS FOR (2026-09-01).
  //
  // The chart filtered on bench_nav != null BEFORE picking the rebase base, so
  // a stale or late-starting benchmark moved the portfolio's base date. In
  // production the same US 1M window read +1.345% against VOO and +0.010%
  // against XLK -- a 134x difference in the PORTFOLIO's own number, caused
  // entirely by the benchmark selection.
  it("reports the same portfolio return regardless of benchmark coverage", () => {
    const full = buildBenchmarkWindow(rows(FULL), null).portfolioReturnPct;
    const stale = buildBenchmarkWindow(rows(STALE), null).portfolioReturnPct;
    const late = buildBenchmarkWindow(rows(LATE_START), null).portfolioReturnPct;
    const none = buildBenchmarkWindow(rows({}), null).portfolioReturnPct;

    expect(full).toBeCloseTo(1.345, 3);
    expect(stale).toBeCloseTo(1.345, 3);
    expect(late).toBeCloseTo(1.345, 3);
    expect(none).toBeCloseTo(1.345, 3);
  });

  it("still measures the DELTA on the overlap only", () => {
    // Rebasing the portfolio from Monday against a benchmark rebased from
    // Wednesday would be a fake relative return; that guard is retained.
    const w = buildBenchmarkWindow(rows(LATE_START), null);
    // Overlap starts 08-26 (nav 100.8) and ends 08-31 (nav 101.345):
    //   portfolio over overlap = (101.345/100.8 - 1)*100 = 0.541%
    //   bench over overlap     = (60.3/60 - 1)*100       = 0.500%
    expect(w.benchReturnPct).toBeCloseTo(0.5, 3);
    expect(w.deltaPct).toBeCloseTo(0.04, 2);
    // And the headline portfolio number is still the FULL window, not 0.541%.
    expect(w.portfolioReturnPct).toBeCloseTo(1.345, 3);
  });
});

describe("truncation is surfaced, not hidden", () => {
  it("flags a stale benchmark and names the last comparable date", () => {
    const w = buildBenchmarkWindow(rows(STALE), null);
    expect(w.truncation).not.toBeNull();
    expect(w.truncation!.until).toBe("2026-08-24");
    expect(w.truncation!.sessionsLost).toBe(5);
  });

  it("reports no truncation when coverage is complete", () => {
    expect(buildBenchmarkWindow(rows(FULL), null).truncation).toBeNull();
  });

  it("refuses a delta when the benchmark has no data in the window", () => {
    const w = buildBenchmarkWindow(rows({}), null);
    expect(w.deltaPct).toBeNull();
    expect(w.benchReturnPct).toBeNull();
    expect(w.truncation!.until).toBeNull();
    // The portfolio line is still drawn.
    expect(w.points).toHaveLength(9);
    expect(w.points.every((p) => p.bench == null)).toBe(true);
  });
});

describe("window and edge cases", () => {
  it("honours the cutoff", () => {
    const cut = new Date("2026-08-26T00:00:00Z").getTime();
    const w = buildBenchmarkWindow(rows(FULL), cut);
    expect(w.points).toHaveLength(4);
    expect(w.points[0].date).toBe("2026-08-26");
  });

  it("returns empty rather than dividing by a single point", () => {
    const w = buildBenchmarkWindow([{ date: "2026-08-19", nav: 100, bench_nav: 50 }], null);
    expect(w.points).toEqual([]);
    expect(w.portfolioReturnPct).toBeNull();
  });

  it("does not crash on a zero base", () => {
    const w = buildBenchmarkWindow([
      { date: "d1", nav: 0, bench_nav: 0 },
      { date: "d2", nav: 10, bench_nav: 5 },
    ], null);
    expect(w.portfolioReturnPct).toBe(0);
  });
});
