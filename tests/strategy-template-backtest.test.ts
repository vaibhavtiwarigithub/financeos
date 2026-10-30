import { describe, expect, it } from "vitest";
import { runTemplateBacktest } from "@/lib/strategy-replay/template-backtest";
import type { Bar } from "@/lib/strategy-replay/compile";
import type { RuleSpec } from "@/lib/strategy-replay/rule-spec";

function series(symbolOffset = 0): Bar[] {
  return Array.from({ length: 80 }, (_, i) => {
    const session = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    const close = 100 + symbolOffset + i * 0.5;
    return { session, open: close - 0.1, high: close + 0.5, low: close - 0.5, close };
  });
}

const spec: RuleSpec = {
  id: "fixed-test", label: "test", role: "entry", market: "us", universe: ["AAA", "BBB"],
  horizonSessions: 3, execution: "next_open", positionSizePct: 1,
  entry: { op: "always" }, exit: { op: "held_sessions", cmp: ">=", value: 3 }, ruleVersion: "test-v1",
};
const provenance = [{ provider: "test fixture", priceBasis: "adjusted", provenanceVersion: "fixture-v1" }];

describe("fixed-rule temporal holdout backtest", () => {
  it("uses the same ordered sessions, equal-weight sleeves, benchmark, and explicit costed simulator", () => {
    const bars = { AAA: series(0), BBB: series(10), VOO: series(0) };
    const result = runTemplateBacktest({ spec, bars, benchmark: "VOO", benchmarkBars: bars, provenance, initialCash: 100_000 });
    expect(result.status).toBe("diagnostic_only");
    expect(result.method).toBe("fixed-rule-70-30-temporal-holdout-v1");
    expect(result.holdout?.sessions).toBeGreaterThan(10);
    expect(result.holdout?.trades).toBeGreaterThan(0);
    expect(result.holdout?.rejections).toBe(0);
    expect(result.holdout?.excessReturnPp).not.toBeNull();
    expect(result.holdout?.unpricedSessions).toBe(0);
    expect(result.holdout?.benchmarkMissingSessions).toBe(0);
    expect(result.holdout?.scenarios.some((row) => row.classifier === "benchmark_trend_50sma")).toBe(true);
    expect(result.holdout?.scenarios.some((row) => row.classifier === "benchmark_volatility_20d_training_tercile")).toBe(true);
  });

  it("keeps the evidence insufficient when there is not enough temporal history", () => {
    const short = series().slice(0, 20);
    const bars = { AAA: short, BBB: short, VOO: short };
    const result = runTemplateBacktest({ spec, bars, benchmark: "VOO", benchmarkBars: bars, provenance, initialCash: 100_000 });
    expect(result.status).toBe("insufficient_data");
    expect(result.holdout).toBeNull();
  });
});
