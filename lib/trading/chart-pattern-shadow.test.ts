import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/technicals";
import {
  detectConfirmedDoubleReversal,
  summarizeChartPatternEvidence,
  summarizeIndependentPatternBlocks,
  studentT95Critical,
} from "./chart-pattern-shadow";

function bars(overrides: Record<number, number>): Candle[] {
  return Array.from({ length: 32 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    close: overrides[i] ?? (96 + Math.sin(i * 1.7) * 0.2),
    open: 96, high: 96, low: 96, volume: 1,
  }));
}

describe("chart pattern shadow", () => {
  it("detects only a confirmed double top at the latest completed close", () => {
    const result = detectConfirmedDoubleReversal(bars({ 8: 100, 14: 94, 21: 100, 31: 93 }));
    expect(result.status).toBe("detected");
    if (result.status === "detected") {
      expect(result.pattern.patternType).toBe("double_top");
      expect(result.pattern.confirmationDate).toBe("2026-02-01");
      expect(result.pattern.necklinePrice).toBe(94);
    }
  });

  it("detects the mirrored double bottom only after a neckline close", () => {
    const result = detectConfirmedDoubleReversal(bars({ 8: 90, 14: 96, 21: 90.5, 31: 97 }));
    expect(result.status).toBe("detected");
    if (result.status === "detected") expect(result.pattern.patternType).toBe("double_bottom");
  });

  it("rejects unconfirmed patterns, equal-price plateaus and short candle history", () => {
    expect(detectConfirmedDoubleReversal(bars({ 8: 100, 14: 94, 21: 100, 31: 95 })).status).toBe("no_pattern");
    expect(detectConfirmedDoubleReversal(bars({ 8: 100, 9: 100, 14: 94, 21: 100, 31: 93 })).status).toBe("no_pattern");
    expect(detectConfirmedDoubleReversal(bars({ 8: 100, 14: 94, 21: 100 }).slice(0, 20)).status).toBe("insufficient_candles");
  });

  it("deduplicates dates and ignores invalid prices before detection", () => {
    const input = bars({ 8: 100, 14: 94, 21: 100, 31: 93 });
    input.push({ ...input[31], close: Number.NaN });
    const result = detectConfirmedDoubleReversal(input);
    expect(result.status).toBe("detected");
  });

  it("uses Student-t bounds and refuses a verdict below 20 independent blocks", () => {
    expect(studentT95Critical(1)).toBe(12.706);
    expect(studentT95Critical(10)).toBe(2.228);
    expect(studentT95Critical(31)).toBeGreaterThan(1.96);
    expect(summarizeIndependentPatternBlocks(Array(19).fill(0.02)).status).toBe("insufficient");
    expect(summarizeIndependentPatternBlocks(Array(20).fill(0.02)).status).toBe("validated");
    expect(summarizeIndependentPatternBlocks(Array(20).fill(-0.02)).status).toBe("contradicted");
  });

  it("blocks observations by market-session time and signs tops against bottoms", () => {
    const sessions = Array.from({ length: 40 }, (_, i) => `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`);
    const events = [
      { session: sessions[0], patternType: "double_top" as const, benchmarkNeutralReturn: -0.04 },
      { session: sessions[1], patternType: "double_bottom" as const, benchmarkNeutralReturn: 0.06 },
      { session: sessions[22], patternType: "double_top" as const, benchmarkNeutralReturn: -0.02 },
    ];
    const summary = summarizeChartPatternEvidence({ sessions, events, horizonDays: 20 });
    expect(summary.maturedEvents).toBe(3);
    expect(summary.independentBlocks.blocks).toBe(2);
    expect(summary.independentBlocks.mean).toBeCloseTo(0.035);
  });
});
