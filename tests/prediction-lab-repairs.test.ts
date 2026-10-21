import { describe, expect, it } from "vitest";
import { availabilityAlignedLabel } from "@/lib/llm-council/availability-label";
import { researchSessionCloseAt } from "@/lib/trading/market-calendar";
import { hacMeanT, sessionDistanceT } from "@/lib/score-variants/core";
import { wilderRsi, evaluate } from "@/lib/strategy-replay/compile";
import { councilComparisons, type CouncilComparisonPoint } from "@/lib/learning/council-comparison";

describe("expected close and data-independent entry", () => {
  it("uses official 2026 early closes and DST without altering ordinary July 2", () => {
    expect(new Date(researchSessionCloseAt("us", "2026-11-27")!).toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(new Date(researchSessionCloseAt("us", "2026-12-24")!).toISOString()).toBe("2026-12-24T18:00:00.000Z");
    expect(new Date(researchSessionCloseAt("us", "2026-07-02")!).toISOString()).toBe("2026-07-02T20:00:00.000Z");
    expect(new Date(researchSessionCloseAt("us", "2026-03-06")!).toISOString()).toBe("2026-03-06T21:00:00.000Z");
    expect(new Date(researchSessionCloseAt("us", "2026-03-09")!).toISOString()).toBe("2026-03-09T20:00:00.000Z");
    expect(researchSessionCloseAt("india", "2026-11-08")).toBeNull();
    expect(researchSessionCloseAt("us", "2027-01-04")).toBeNull();
    expect(researchSessionCloseAt("us", "2026-02-30")).toBeNull();
  });
  it("does not use a close that printed before an early-close forecast", () => {
    const dates = ["2026-11-27", "2026-11-30", "2026-12-01", "2026-12-02"];
    const marks = dates.map((date, i) => ({ date, close: 100 + i }));
    const label = availabilityAlignedLabel({ market: "us", availableAt: "2026-11-27T19:00:00Z", asOf: "2026-12-02T21:00:00Z", horizonDays: 2, symbolMarks: marks, benchmarkMarks: marks });
    expect(label?.entrySession).toBe("2026-11-30");
    expect(label?.endSession).toBe("2026-12-02");
  });
  it("refuses missing expected entry even if later marks form a valid window", () => {
    const marks = ["2026-09-29", "2026-09-30", "2026-10-01"].map((date) => ({ date, close: 100 }));
    expect(availabilityAlignedLabel({ market: "us", availableAt: "2026-09-28T19:00:00Z", horizonDays: 2, symbolMarks: marks, benchmarkMarks: marks })).toBeNull();
  });
  it("does not mature an intraday cache mark before the horizon close", () => {
    const marks = ["2026-09-28", "2026-09-29", "2026-09-30"].map((date) => ({ date, close: 100 }));
    const input = { market: "us" as const, availableAt: "2026-09-28T19:00:00Z", horizonDays: 2, symbolMarks: marks, benchmarkMarks: marks };
    expect(availabilityAlignedLabel({ ...input, asOf: "2026-09-30T19:59:59Z" })).toBeNull();
    expect(availabilityAlignedLabel({ ...input, asOf: "2026-09-30T20:00:00Z" })?.endSession).toBe("2026-09-30");
  });
  it("fails closed across an India special session", () => {
    const marks = ["2026-11-06", "2026-11-09", "2026-11-11"].map((date) => ({ date, close: 100 }));
    expect(availabilityAlignedLabel({ market: "india", availableAt: "2026-11-06T09:00:00Z", asOf: "2026-11-12T12:00:00Z", horizonDays: 2, symbolMarks: marks, benchmarkMarks: marks })).toBeNull();
  });
});

describe("explicit RSI semantics", () => {
  it("matches Wilder's standard reference sequence", () => {
    const prices = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46.00,46.03];
    expect(wilderRsi(prices, 14, 14)).toBeCloseTo(70.4641, 3);
    expect(wilderRsi(prices, 15, 14)).toBeCloseTo(66.2496, 3);
    expect(wilderRsi(prices, 16, 14)).toBeCloseTo(66.4809, 3);
  });
  it("keeps old simple operator distinct; handles flat, warmup and invalid input", () => {
    expect(wilderRsi([1,1,1,1], 3, 2)).toBe(50);
    expect(wilderRsi([1,2], 1, 2)).toBeNull();
    expect(wilderRsi([1,2,NaN], 2, 2)).toBeNull();
    const bars = [10,12,11,10,13].map((close, i) => ({ session: `2026-01-0${i+1}`, open: close, high: close, low: close, close }));
    expect(evaluate({ op: "cmp", left: { fn: "rsi", period: 2 }, cmp: ">", right: 80 }, { bars, idx: 4 })).toBe(false);
    expect(evaluate({ op: "cmp", left: { fn: "rsi_wilder", period: 2 }, cmp: ">", right: 80 }, { bars, idx: 4 })).toBe(true);
  });
});

describe("session-distance descriptive statistics", () => {
  it("equals ordinary Bartlett HAC at consecutive positions, not across gaps", () => {
    const xs = [1,2,4,3,7,5];
    expect(hacMeanT(xs, 2, [0,1,2,3,4,5])).toBeCloseTo(hacMeanT(xs, 2)!, 12);
    expect(hacMeanT(xs, 2, [0,3,6,9,12,15])).toBeCloseTo(hacMeanT(xs, 0)!, 12);
    expect(hacMeanT(xs, 2, [0,1,1,3,4,5])).toBeNull();
    expect(sessionDistanceT([{ day: "2026-09-28", value: 1 }, { day: "2026-10-05", value: 3 }], 2, "us")).toBeCloseTo(hacMeanT([1,3], 0)!, 12);
    expect(sessionDistanceT([{ day: "2026-11-06", value: 1 }, { day: "2026-11-09", value: 3 }], 2, "india")).toBeNull();
  });
  it("computes delta on matched raw symbols, measures actual score similarity and withholds tiny-sample t", () => {
    const points: CouncilComparisonPoint[] = Array.from({ length: 5 }, (_, i) => ({ method: "test", symbol: `S${i}`, session: "2026-09-28", observationId: String(i), decisionTs: "2026-09-28T12:00:00Z", score: i*20, baseline: 100-i*20, outcome: i/100 }));
    const [cell] = councilComparisons(points, "us", 2);
    expect(cell.ic).toBeCloseTo(1); expect(cell.baselineIc).toBeCloseTo(-1); expect(cell.deltaIc).toBeCloseTo(2);
    expect(cell.scoreRankCorrelation).toBeCloseTo(-1); expect(cell.descriptiveHacT).toBeNull();
    expect(cell.state).toBe("insufficient_evidence");
    expect(councilComparisons(points.slice(1), "us", 2)[0].sessions).toBe(0);
    expect(councilComparisons(points.map((p) => ({ ...p, score: 50 })), "us", 2)[0].ic).toBeNull();
    expect(councilComparisons([...points].reverse(), "us", 2)[0].commonSampleHash).toBe(cell.commonSampleHash);
  });
});
