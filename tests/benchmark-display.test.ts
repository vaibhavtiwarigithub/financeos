import { describe, expect, it } from "vitest";
import {
  mergePortfolioBenchmarkSeries,
  benchmarkFreshness,
  pipelineFreshness,
  selectDisplayBenchmark,
  type DisplayBenchmark,
} from "@/lib/analytics/benchmark-display";

const choices: DisplayBenchmark[] = [
  { id: "voo", label: "VOO", symbol: "VOO", provider_symbol: "VOO", is_primary: true },
  { id: "qqq", label: "QQQ", symbol: "QQQ", provider_symbol: "QQQ", is_primary: false },
];

describe("portfolio benchmark display selection", () => {
  it("uses request, then saved display preference, then governed primary", () => {
    expect(selectDisplayBenchmark(choices, "qqq", "voo")?.id).toBe("qqq");
    expect(selectDisplayBenchmark(choices, null, "qqq")?.id).toBe("qqq");
    expect(selectDisplayBenchmark(choices, null, "missing")?.id).toBe("voo");
  });

  it("does not invent a benchmark when none are enabled", () => {
    expect(selectDisplayBenchmark([], "qqq", "voo")).toBeNull();
  });

  it("joins portfolio and benchmark on exact dates without forward fill", () => {
    expect(mergePortfolioBenchmarkSeries(
      [{ date: "2026-08-20", nav: 100 }, { date: "2026-08-21", nav: 101 }],
      [{ date: "2026-08-21", close: 200 }],
    )).toEqual([
      { date: "2026-08-20", nav: 100, bench_nav: null },
      { date: "2026-08-21", nav: 101, bench_nav: 200 },
    ]);
  });

  it("reports a comparator that has rows but is behind the paper book as stale", () => {
    expect(benchmarkFreshness(
      [{ date: "2026-09-10", nav: 100 }, { date: "2026-09-11", nav: 101 }],
      [{ date: "2026-09-10", close: 200 }],
    )).toMatchObject({
      status: "stale",
      latestPortfolioDate: "2026-09-11",
      latestBenchmarkDate: "2026-09-10",
      missingPortfolioSessions: 1,
    });
  });
});

// The defect this layer exists for: `status` is RELATIVE, so two ledgers that
// stall together still read "ok". Only the calendar can tell them apart.
describe("absolute pipeline freshness against the market calendar", () => {
  const calendar = (expectedSessionDate: string | null, closedReason: string | null = null) => ({
    expectedSessionDate,
    calendarSupported: true,
    closedReason,
    todayLocalYmd: "2026-09-14",
  });

  it("calls a series ending on the last close current, even days later", () => {
    // Fri 2026-09-11 close, read on Mon 2026-09-14 (an NSE holiday): correct, not stale.
    expect(pipelineFreshness("2026-09-11", "2026-09-11", calendar("2026-09-11", "market holiday")))
      .toMatchObject({ state: "current", portfolioBehind: false, benchmarkBehind: false, closedReason: "market holiday" });
  });

  it("catches BOTH ledgers stalling together — the case relative status calls ok", () => {
    const both = benchmarkFreshness(
      [{ date: "2026-09-08", nav: 100 }],
      [{ date: "2026-09-08", close: 200 }],
      calendar("2026-09-11"),
    );
    expect(both.status).toBe("ok");
    expect(both.pipeline).toMatchObject({ state: "behind", portfolioBehind: true, benchmarkBehind: true });
  });

  it("attributes a lag to the side that is actually behind", () => {
    expect(pipelineFreshness("2026-09-11", "2026-09-08", calendar("2026-09-11")))
      .toMatchObject({ state: "behind", portfolioBehind: false, benchmarkBehind: true });
    expect(pipelineFreshness("2026-09-08", "2026-09-11", calendar("2026-09-11")))
      .toMatchObject({ state: "behind", portfolioBehind: true, benchmarkBehind: false });
  });

  it("stays unknown rather than claiming staleness it cannot prove", () => {
    expect(pipelineFreshness("2026-09-11", "2026-09-11").state).toBe("unknown");
    expect(pipelineFreshness("2026-09-11", "2026-09-11", {
      expectedSessionDate: null, calendarSupported: false, closedReason: null, todayLocalYmd: null,
    }).state).toBe("unknown");
  });

  it("treats an empty ledger as behind, not as current", () => {
    expect(pipelineFreshness(null, null, calendar("2026-09-11")))
      .toMatchObject({ state: "behind", portfolioBehind: true, benchmarkBehind: true });
  });
});
