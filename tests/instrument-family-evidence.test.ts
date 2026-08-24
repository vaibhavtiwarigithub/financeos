import { describe, expect, it } from "vitest";
import { _test } from "@/lib/scoring/instrument-family-evidence";

describe("instrument-family measure-only evidence", () => {
  it("uses dated endpoints rather than array offsets", () => {
    expect(_test.seriesChange([
      { date: "2026-08-21", value: 1.75 },
      { date: "2026-07-24", value: 2.05 },
    ])).toEqual({ value: -0.3, asOf: "2026-08-21" });
  });

  it("computes settled-bar returns in chronological order", () => {
    expect(_test.returnPct([
      { symbol: "GLD", date: "2026-08-21", close: 110 },
      { symbol: "GLD", date: "2026-07-24", close: 100 },
    ], "GLD")).toEqual({ value: 10, asOf: "2026-08-21" });
  });

  it("never fabricates a value from insufficient history", () => {
    expect(_test.returnPct([{ symbol: "SLV", date: "2026-08-21", close: 50 }], "SLV").value).toBeNull();
    expect(_test.seriesChange([]).value).toBeNull();
  });
});
