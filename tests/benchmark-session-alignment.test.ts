import { describe, expect, it } from "vitest";
import { benchmarkReturnPct, selectBenchmarkObservation } from "@/lib/paper/benchmark-observation";

describe("benchmark session alignment", () => {
  const bars = [
    { date: "2026-08-13", open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { date: "2026-08-14", open: 101, high: 101, low: 101, close: 101, volume: 1 },
  ];

  it("accepts only the requested market session", () => {
    const result = selectBenchmarkObservation(bars, "VOO", "yahoo", "2026-08-14");
    expect(result).toMatchObject({ ok: true, observation: { sessionDate: "2026-08-14", close: 101 } });
  });

  it("refuses to stamp the previous close under a later portfolio date", () => {
    const result = selectBenchmarkObservation(bars, "VOO", "yahoo", "2026-08-15");
    expect(result).toMatchObject({ ok: false, reason: "benchmark_session_mismatch", latestSessionDate: "2026-08-14" });
  });

  it("does not fabricate a return without a valid baseline", () => {
    expect(benchmarkReturnPct(101, null)).toBeNull();
    expect(benchmarkReturnPct(101, 0)).toBeNull();
    expect(benchmarkReturnPct(101, 100)).toBeCloseTo(1);
  });
});
