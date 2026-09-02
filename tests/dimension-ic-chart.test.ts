import { describe, expect, it } from "vitest";
import { buildChartRows, rollingMean } from "@/lib/learning/dimension-ic-chart";

// Chart-assembly logic for the Dimension Rank IC panel. Display-only — nothing
// here reaches a score, size, exit or order — but the union-onto-one-axis step
// is the kind of code that quietly invents data points, so it gets a check.

const pt = (date: string, ic: number, cross_section = 8) => ({ date, ic, cross_section });

describe("buildChartRows", () => {
  it("unions dimensions onto one sorted date axis", () => {
    const rows = buildChartRows([
      { key: "sentiment", points: [pt("2026-03-02", 0.2), pt("2026-03-01", 0.1)] },
      { key: "technical", points: [pt("2026-03-03", -0.4)] },
    ]);
    expect(rows.map((r) => r.date)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("leaves a dimension's non-qualifying days ABSENT, never zero", () => {
    // In production insider qualifies on 21 sessions where sentiment qualifies
    // on 29 — availability differs. A 0 on the missing days would draw a real
    // observation ("ranked neutrally that day") on a day it was never measured,
    // and connectNulls={false} could not break the line because 0 is not null.
    const rows = buildChartRows([
      { key: "sentiment", points: [pt("2026-03-01", 0.1), pt("2026-03-02", 0.2)] },
      { key: "insider", points: [pt("2026-03-02", 0.5)] },
    ]);
    expect(rows[0].insider).toBeUndefined();
    expect(rows[0].insider).not.toBe(0);
    expect(rows[1].insider).toBe(0.5);
  });

  it("keeps each dimension's IC on its own date, not by position", () => {
    // Two dimensions with disjoint dates: a positional (index-aligned) merge
    // would smear technical's value onto sentiment's day.
    const rows = buildChartRows([
      { key: "sentiment", points: [pt("2026-03-01", 0.11)] },
      { key: "technical", points: [pt("2026-03-05", -0.55)] },
    ]);
    expect(rows.find((r) => r.date === "2026-03-01")!.sentiment).toBe(0.11);
    expect(rows.find((r) => r.date === "2026-03-01")!.technical).toBeUndefined();
    expect(rows.find((r) => r.date === "2026-03-05")!.technical).toBe(-0.55);
  });

  it("adds a rolling series only for the focused dimension", () => {
    const points = Array.from({ length: 9 }, (_, i) => pt(`2026-03-0${i + 1}`, i / 10));
    const focused = buildChartRows([{ key: "technical", points }], "technical");
    expect(focused.some((r) => r.rolling != null)).toBe(true);

    const unfocused = buildChartRows([{ key: "technical", points }]);
    expect(unfocused.every((r) => r.rolling === undefined)).toBe(true);
  });

  it("survives an empty series without throwing", () => {
    // h60/h120 have no matured labels until ~2026-09-29 and legitimately
    // arrive with zero points.
    expect(buildChartRows([{ key: "macro", points: [] }], "macro")).toEqual([]);
    expect(buildChartRows([])).toEqual([]);
  });
});

describe("rollingMean", () => {
  it("is null until the window is full, then trails", () => {
    const series = [pt("d1", 1), pt("d2", 2), pt("d3", 3), pt("d4", 4)];
    expect(rollingMean(series, 3)).toEqual([null, null, 2, 3]);
  });

  it("never looks ahead", () => {
    // A centred or forward-looking window would let a later session's IC change
    // an earlier point — the chart equivalent of a lookahead bug.
    const rising = [pt("d1", 0), pt("d2", 0), pt("d3", 100)];
    expect(rollingMean(rising, 2)[1]).toBe(0);
  });
});
