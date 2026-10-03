import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/data/technicals";
import {
  CHART_PATTERN_SHADOW_VERSION,
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

  it("v2: a breakout older than the confirmation window is NOT a detection (v1 re-detected AMD daily, 15% above its neckline)", () => {
    // double bottom 8/21, neckline 14 = 96, first close through the neckline at bar 24 (97), still above at 31.
    const old = detectConfirmedDoubleReversal(bars({ 8: 90, 14: 96, 21: 90.5, 24: 97, 25: 98, 26: 99, 27: 100, 28: 101, 29: 102, 30: 103, 31: 104 }));
    expect(old.status).toBe("no_pattern");
  });

  it("v2: confirmation is the FIRST close through the neckline, within 2 sessions of the latest bar", () => {
    // first break at bar 30 (97); bar 31 still above. Latest is 1 bar after the break.
    const fresh = detectConfirmedDoubleReversal(bars({ 8: 90, 14: 96, 21: 90.5, 30: 97, 31: 98 }));
    expect(fresh.status).toBe("detected");
    if (fresh.status === "detected") {
      expect(fresh.pattern.confirmationDate).toBe("2026-01-31"); // bar 30 = Jan 31, not the latest bar (Feb 1)
      expect(fresh.pattern.confirmationPrice).toBe(97);
    }
    // same for a double top: first close below the trough at bar 29 is 3 bars before the latest bar (31) -> too old
    expect(detectConfirmedDoubleReversal(bars({ 8: 100, 14: 94, 21: 100, 28: 93, 29: 92, 30: 91, 31: 90 })).status).toBe("no_pattern");
    expect(detectConfirmedDoubleReversal(bars({ 8: 100, 14: 94, 21: 100, 29: 93, 30: 92, 31: 91 })).status).toBe("detected");
  });

  it("v2: the detector version is bumped so v1 rows can never be pooled with v2 evidence", () => {
    expect(CHART_PATTERN_SHADOW_VERSION).toBe("double-reversal.close.v2");
    const route = readFileSync("app/api/agents/chart-pattern-shadow/route.ts", "utf8");
    expect(route.match(/eq\("detector_version", CHART_PATTERN_SHADOW_VERSION\)/g)?.length).toBe(2);
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
