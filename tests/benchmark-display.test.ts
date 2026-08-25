import { describe, expect, it } from "vitest";
import {
  mergePortfolioBenchmarkSeries,
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
});
