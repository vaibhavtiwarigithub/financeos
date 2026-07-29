import { describe, it, expect } from "vitest";
import { forwardReturn, computeDateIc, runOosFolds, describeSigma } from "./oos-runner";
import type { Candle } from "@/lib/data/technicals";
import type { EdgeDef } from "@/lib/edges/types";

const day = (i: number) => `2026-01-${String(i + 1).padStart(2, "0")}`;
const mkCandles = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ date: day(i), open: c, high: c, low: c, close: c, volume: 1000 }));

describe("forwardReturn", () => {
  const c = mkCandles([100, 110, 120, 130]);

  it("measures from the as-of session forward by the horizon", () => {
    expect(forwardReturn(c, day(0), 2)).toBeCloseTo(0.2, 10); // 100 -> 120
  });

  it("returns null when the label has NOT matured by the data cutoff", () => {
    // A partially matured label is a shorter horizon wearing the same name;
    // averaging it with full-horizon labels silently changes what IC measures.
    expect(forwardReturn(c, day(2), 2)).toBeNull(); // would need index 4, only 0-3 exist
    expect(forwardReturn(c, day(3), 1)).toBeNull();
  });

  it("returns null for an unknown as-of session or unusable price", () => {
    expect(forwardReturn(c, "2026-02-01", 1)).toBeNull();
    expect(forwardReturn(mkCandles([0, 50]), day(0), 1)).toBeNull();
  });
});

/** Edge that reports the last close — trivially inspectable for leakage. */
const lastClose: EdgeDef = {
  id: "test_last_close", name: "last close", category: "technical",
  expectedSign: 1, horizonDays: 1, minCandles: 1,
  rationale: "", dataSource: "", references: [],
  compute: (ctx: { candles: Candle[] }) => ctx.candles[ctx.candles.length - 1]?.close ?? null,
} as unknown as EdgeDef;

describe("computeDateIc — no lookahead", () => {
  const base = {
    market: "us" as const, edge: lastClose, horizonSessions: 1, minCrossSection: 3,
    benchmark: mkCandles([10, 11, 12, 13, 14]),
  };

  it("feeds the edge ONLY candles at or before as-of", () => {
    // Each symbol's series rises monotonically, so if the edge ever saw the full
    // series its value would be the final close and be identical across dates.
    const series = new Map<string, Candle[]>([
      ["A", mkCandles([1, 2, 3, 4, 5])],
      ["B", mkCandles([10, 20, 30, 40, 50])],
      ["C", mkCandles([100, 200, 300, 400, 500])],
    ]);
    const seen: number[] = [];
    const spy: EdgeDef = { ...lastClose, compute: (ctx) => { const v = ctx.candles[ctx.candles.length - 1].close; seen.push(v); return v; } } as EdgeDef;
    computeDateIc({ ...base, edge: spy, asOf: day(1), universe: ["A", "B", "C"], series });
    // At day(1) the visible closes are the SECOND element, never the fifth.
    expect(seen).toEqual([2, 20, 200]);
  });

  it("feeds the edge ONLY benchmark candles at or before as-of", () => {
    const series = new Map<string, Candle[]>([
      ["A", mkCandles([1, 3, 4])],
      ["B", mkCandles([2, 3, 5])],
      ["C", mkCandles([3, 3, 6])],
    ]);
    const seenBenchmarkDates: string[] = [];
    const spy: EdgeDef = {
      ...lastClose,
      compute: (ctx) => {
        seenBenchmarkDates.push(ctx.benchmark[ctx.benchmark.length - 1]?.date ?? "");
        return ctx.candles[ctx.candles.length - 1].close;
      },
    } as EdgeDef;
    computeDateIc({ ...base, edge: spy, asOf: day(1), universe: ["A", "B", "C"], series });
    expect(seenBenchmarkDates).toEqual([day(1), day(1), day(1)]);
  });

  it("excludes a sparse date rather than scoring it IC = 0", () => {
    // Too few names to measure is a different claim from "no predictive power".
    const series = new Map<string, Candle[]>([["A", mkCandles([1, 2, 3])]]);
    const r = computeDateIc({ ...base, asOf: day(0), universe: ["A"], series });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cross_section_below_min");
  });

  it("drops names whose label has not matured", () => {
    const series = new Map<string, Candle[]>([
      ["A", mkCandles([1, 2, 3])],
      ["B", mkCandles([10, 20, 30])],
      ["C", mkCandles([100, 200, 300])],
    ]);
    // At the last session no forward return exists for anyone.
    const r = computeDateIc({ ...base, asOf: day(2), universe: ["A", "B", "C"], series });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.crossSection).toBe(0);
  });

  it("uses only the PIT universe for that date, ignoring other available series", () => {
    // Forward returns must DIFFER or the rank correlation is undefined — see the
    // degenerate-cross-section case below.
    const series = new Map<string, Candle[]>([
      ["A", mkCandles([1, 2, 3])],        // fwd +100%
      ["B", mkCandles([10, 12, 14])],     // fwd  +20%
      ["C", mkCandles([100, 150, 200])],  // fwd  +50%
      ["LATER", mkCandles([9, 9, 9])],    // listed only after this date
    ]);
    const r = computeDateIc({ ...base, asOf: day(0), universe: ["A", "B", "C"], series });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.crossSection).toBe(3); // LATER excluded — not in the PIT set
  });

  it("refuses a degenerate cross-section instead of reporting a bogus IC", () => {
    // Identical forward returns => zero variance in the label => rank
    // correlation is undefined. Reporting 0 here would read as "no predictive
    // power" when the truth is "unmeasurable".
    const series = new Map<string, Candle[]>([
      ["A", mkCandles([1, 2, 3])], ["B", mkCandles([2, 4, 6])], ["C", mkCandles([3, 6, 9])],
    ]);
    const r = computeDateIc({ ...base, asOf: day(0), universe: ["A", "B", "C"], series });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ic_not_finite");
  });
});

describe("runOosFolds", () => {
  const folds = [
    { index: 0, asOfDates: [day(0)], labelEndDate: day(1), startIndex: 0, labelEndIndex: 1 },
    { index: 1, asOfDates: [day(2)], labelEndDate: day(3), startIndex: 2, labelEndIndex: 3 },
  ];
  const series = new Map<string, Candle[]>([
    ["A", mkCandles([1, 2, 3, 4, 5])],
    ["B", mkCandles([5, 4, 3, 2, 1])],
    ["C", mkCandles([2, 3, 1, 5, 4])],
  ]);

  it("records a skip reason instead of silently dropping a date", () => {
    const r = runOosFolds({
      folds, universeByDate: new Map([[day(0), ["A", "B", "C"]]]), // day(2) missing
      series, benchmark: mkCandles([1, 2, 3, 4, 5]), edge: lastClose,
      market: "us", horizonSessions: 1, stepSessions: 1, minCrossSection: 3,
    });
    expect(r.datesSkipped.some((s) => s.asOf === day(2) && s.reason === "universe_unavailable")).toBe(true);
    expect(r.datesEvaluated + r.datesSkipped.length).toBe(2); // every date accounted for
  });

  it("normalizes expectedSign=-1 so positive IC always means the edge worked", () => {
    const lowIsGood: EdgeDef = {
      ...lastClose,
      id: "test_low_is_good",
      expectedSign: -1,
    } as EdgeDef;
    const r = runOosFolds({
      folds: [folds[0]],
      universeByDate: new Map([[day(0), ["A", "B", "C"]]]),
      series,
      benchmark: mkCandles([1, 2, 3, 4, 5]),
      edge: lowIsGood,
      market: "us",
      horizonSessions: 1,
      stepSessions: 1,
      minCrossSection: 3,
    });
    expect(r.perDate).toHaveLength(1);
    // Raw last-close ordering and next-day return ordering are opposed here.
    // A lower-is-better edge must invert that raw IC to positive evidence.
    expect(r.perDate[0].ic).toBeGreaterThan(0);
    expect(r.perDate[0].crossSection).toBe(3);
  });
});

describe("describeSigma — the Annex F stop condition", () => {
  it("states the plan holds when sigma is inside the ceiling", () => {
    const s = describeSigma({
      n: 24, meanIc: 0.05, sigmaIc: 0.08, seHac: 0.016, tHac: 3.1, lag: 1,
      sigmaWithinPlan: true, foldSigns: [1, 1, 1],
    });
    expect(s).toContain("within the 0.10 planning ceiling");
    expect(s).toContain("PRELIMINARY");
    expect(s).toContain("does not by itself validate");
  });

  it("says STOP and computes the dates actually required when sigma is too high", () => {
    const s = describeSigma({
      n: 24, meanIc: 0.05, sigmaIc: 0.438, seHac: 0.09, tHac: 0.56, lag: 1,
      sigmaWithinPlan: false, foldSigns: [1, -1, 1],
    });
    expect(s).toContain("PRELIMINARY STOP");
    expect(s).toContain("~480 as-of dates"); // (2*0.438/0.04)^2
    expect(s).toContain("fully PIT");
  });

  it("handles too few dates to measure at all", () => {
    expect(describeSigma(null)).toContain("too few evaluated dates");
  });
});
