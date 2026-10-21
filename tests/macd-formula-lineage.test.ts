import { describe, expect, it } from "vitest";
import { computeTechnicals, scoreTechnicals, scoreTechnicalsV1, technicalScoreTrace, type Candle } from "@/lib/data/technicals";
import { buildFormulaLineage, FORMULA_VERSIONS } from "@/lib/scoring/formula-lineage";
import { technicalFeatureDiagnostics, type FeaturePoint } from "@/lib/learning/technical-feature-diagnostics";
import { EDGE_BY_ID } from "@/lib/edges/registry";

const bars = (count: number): Candle[] => Array.from({ length: count }, (_, i) => ({ date: `test-${i}`, close: 100 + i * .2 + Math.sin(i / 3), open: 100 + i * .2, high: 102 + i * .2, low: 98 + i * .2, volume: 100000 }));
const base = () => ({ ...computeTechnicals(bars(70)), rsi14: 50, trend20d: "flat" as const, priceVsEma20: "above" as const, priceVsEma50: "below" as const, lastReturnPct: 0, atrMultipleMove: 0, volumeVsAvg20: 1 });

describe("direct bounded MACD and immutable formula lineage", () => {
  it("changes current score for valid bullish/bearish MACD but preserves V1", () => {
    const positive = { ...base(), macdLine: 2, macdSignal: 0, macdHistogram: 2, atr14: 2 };
    const negative = { ...positive, macdLine: -2, macdHistogram: -2 };
    expect(scoreTechnicals(positive)).toBeGreaterThan(scoreTechnicalsV1(positive));
    expect(scoreTechnicals(negative)).toBeLessThan(scoreTechnicalsV1(negative));
    expect(scoreTechnicalsV1(positive)).toBe(scoreTechnicalsV1(negative));
    expect(Math.abs(technicalScoreTrace(positive).macd_contribution)).toBeLessThanOrEqual(5);
    const scaled = { ...positive, macdLine: 200, macdHistogram: 200, atr14: 200 };
    expect(scoreTechnicals(scaled)).toBe(scoreTechnicals(positive));
    const zero = { ...positive, macdLine: 0, macdSignal: 0, macdHistogram: 0 };
    expect(scoreTechnicals(zero)).toBe(scoreTechnicalsV1(zero));
    expect(technicalScoreTrace(zero).macd_contribution).toBe(0);
    const saturated = { ...positive, macdHistogram: 1e10 };
    expect(technicalScoreTrace(saturated).macd_contribution).toBe(5);
  });
  it("does not invent MACD/ATR or let MACD override the veto", () => {
    for (const atr14 of [null, 0, -1, NaN, Infinity]) {
      const t = { ...base(), macdLine: 2, macdSignal: 0, macdHistogram: 2, atr14 };
      expect(scoreTechnicals(t)).toBe(scoreTechnicalsV1(t));
      expect(technicalScoreTrace(t).macd_status).toBe("unavailable");
    }
    const crash = { ...base(), macdLine: 100, macdSignal: 0, macdHistogram: 100, atr14: 1, lastReturnPct: -10, atrMultipleMove: 3 };
    expect(scoreTechnicals(crash)).toBe(20);
    expect(technicalScoreTrace(crash).macd_contribution).toBe(0);
    expect(scoreTechnicals({ ...base(), dataPoints: 14 })).toBe(50);
  });
  it("requires a fully seeded signal and consecutive prior MACD state", () => {
    expect(computeTechnicals(bars(33)).macdHistogram).toBeNull();
    expect(computeTechnicals(bars(34)).macdHistogram).not.toBeNull();
    expect(computeTechnicals(bars(34)).macdSignalCross).toBeNull();
    expect(computeTechnicals(bars(35)).macdSignalCross).not.toBeNull();
    const full = bars(100);
    const at60 = computeTechnicals(full.slice(0, 60));
    expect(at60.macdPreviousHistogram).toBe(computeTechnicals(full.slice(0, 59)).macdHistogram);
    const changedFuture = full.map((bar, index) => index < 60 ? bar : { ...bar, close: bar.close * 10 });
    expect(computeTechnicals(changedFuture.slice(0, 60))).toEqual(at60);
    expect(EDGE_BY_ID.kairos_technical_score_v1.compute({ symbol: "TEST", market: "us", asOf: "2026-10-01", candles: full, benchmark: full })).toBe(scoreTechnicalsV1(computeTechnicals(full)));
  });
  it("hashes actual configuration, not property order, and names the new formula", () => {
    expect(FORMULA_VERSIONS.technical).toBe("technical_dimension_v2_macd");
    expect(buildFormulaLineage({ a: 1, b: 2 }).configurationHash).toBe(buildFormulaLineage({ b: 2, a: 1 }).configurationHash);
    expect(buildFormulaLineage({ a: 1 }).configurationHash).not.toBe(buildFormulaLineage({ a: 2 }).configurationHash);
  });
});

describe("fixed feature diagnostics", () => {
  const points = (dates: string[]) => dates.flatMap((day, d) => Array.from({ length: 5 }, (_, s): FeaturePoint => ({ id: d * 5 + s, symbol: `S${s}`, day, ts: `${day}T13:00:00Z`, formula: "test-v1", technical: { rsi14: 20 + s * 15, macdHistogram: s - 2, atr14: 2, macdLine: s - 2 }, outcome: s / 100 })));
  it("computes cross-sectional feature IC, not IID symbol t; missing crossovers stay missing", () => {
    const result = technicalFeatureDiagnostics(points(["2026-10-01", "2026-10-02"]), "us", 2, false);
    expect(result.find((r) => r.feature === "rsi14_level")?.rankIc).toBeCloseTo(1);
    expect(result.every((r) => r.descriptiveT == null)).toBe(true);
    expect(result.find((r) => r.feature === "macd_bull_cross_below_zero")?.observations).toBe(0);
    expect(result.find((r) => r.feature === "rsi14_below30")?.triggered).toBe(2);
  });
  it("uses non-overlapping dates for one symbol and does not call it cross-sectional", () => {
    const one = points(["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]).filter((p) => p.symbol === "S1");
    const r = technicalFeatureDiagnostics(one, "us", 2, true).find((c) => c.feature === "rsi14_level")!;
    expect(r.mode).toBe("nonoverlapping_time_series"); expect(r.observations).toBe(3);
    expect(r.rankIc).toBeNull(); expect(r.descriptiveT).toBeNull();
  });
  it("keeps versions separate and cannot manufacture an IC from constant values", () => {
    const p = points(["2026-10-01"]);
    const r = technicalFeatureDiagnostics([...p, ...p.map((v) => ({ ...v, id: v.id + 5, formula: "test-v2", technical: { rsi14: 50 } }))], "us", 2, false);
    expect(r.filter((c) => c.feature === "rsi14_level")).toHaveLength(2);
    expect(r.find((c) => c.formula === "test-v2" && c.feature === "rsi14_level")?.rankIc).toBeNull();
  });
  it("separates frozen instrument families rather than making five symbols by pooling them", () => {
    const p = points(["2026-10-01"]).map((row, index) => ({ ...row, family: index < 3 ? "operating_company" : "leveraged_or_inverse_etf" }));
    const cells = technicalFeatureDiagnostics(p, "us", 2, false).filter((c) => c.feature === "rsi14_level");
    expect(cells).toHaveLength(2);
    expect(cells.every((c) => c.rankIc == null && c.qualifyingDates === 0)).toBe(true);
    expect(cells.map((c) => c.observations).sort()).toEqual([2, 3]);
  });
  it("does not replace a missing latest feature with an older, available observation", () => {
    const p = points(["2026-10-01"]);
    const missing = { ...p[0], id: 100, ts: "2026-10-01T14:00:00Z", technical: { rsi14: null } };
    const cells = technicalFeatureDiagnostics([...p, missing], "us", 2, false);
    expect(cells.find((c) => c.feature === "rsi14_level")?.observations).toBe(4);
    expect(cells.find((c) => c.feature === "rsi14_level")?.rankIc).toBeNull();
    const overflow = p.map((r) => ({ ...r, technical: { macdHistogram: 1e308, atr14: 1e-308 } }));
    expect(technicalFeatureDiagnostics(overflow, "us", 2, false).find((c) => c.feature === "macd_histogram_atr")?.observations).toBe(0);
  });
});
