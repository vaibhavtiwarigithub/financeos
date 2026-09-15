import { describe, expect, it } from "vitest";
import { _test, oilExposureClass } from "@/lib/scoring/instrument-family-evidence";

const bars = (symbol: string, closes: number[]) =>
  closes.map((close, i) => ({ symbol, date: `2026-08-${String(i + 1).padStart(2, "0")}`, close }));

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
    ], "GLD", 1)).toEqual({ value: 10, asOf: "2026-08-21" });
  });

  it("measures exactly the last N bars, not every cached row", () => {
    // 30 bars: 100 for the first 9, then 200 for the last 21. A first-to-last
    // return over all rows would read +100%; the 20-bar window is flat.
    const closes = [...Array(9).fill(100), ...Array(21).fill(200)];
    expect(_test.returnPct(bars("GLD", closes), "GLD", 20).value).toBe(0);
  });

  it("never fabricates a value from insufficient history", () => {
    expect(_test.returnPct([{ symbol: "SLV", date: "2026-08-21", close: 50 }], "SLV").value).toBeNull();
    expect(_test.returnPct(bars("SLV", Array(20).fill(50)), "SLV", 20).value).toBeNull();
    expect(_test.seriesChange([]).value).toBeNull();
    expect(_test.seriesPct([{ date: "2026-09-09", value: 97 }], 5).value).toBeNull();
  });

  it("computes FRED percent change from newest-first rows", () => {
    const rows = [{ date: "2026-09-09", value: 110 }, ...Array(4).fill({ date: "2026-09-02", value: 105 }), { date: "2026-09-01", value: 100 }];
    expect(_test.seriesPct(rows, 5)).toEqual({ value: 10, asOf: "2026-09-09" });
  });

  it("maps only curated oil exposures, per market", () => {
    expect(oilExposureClass("oxy", "us")).toBe("upstream_producer");
    expect(oilExposureClass("BPCL.NS", "india")).toBe("downstream_marketer");
    expect(oilExposureClass("BPCL.NS", "us")).toBeNull();
    expect(oilExposureClass("AAPL", "us")).toBeNull();
  });
});
