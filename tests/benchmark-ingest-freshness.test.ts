import { describe, it, expect } from "vitest";

// Pins the provider-selection rule for SECONDARY benchmark ingestion.
//
// THE BUG THIS GUARDS AGAINST (2026-09-01): the fallback fired only when the
// preferred provider returned NOTHING. A provider returning 500 bars that all
// end eight days ago passed that check, so the benchmark went stale silently.
// Measured in production: XLF had fallen back to Yahoo and was current at
// 2026-08-31, while XLK stayed on Massive ending 2026-08-24. The chart then
// truncated the PORTFOLIO series to the stale benchmark, reporting +0.010%
// instead of +1.345% for the same window.

import { pickFreshestProvider, newestBarDate } from "@/lib/data/benchmark-ingest";

const bars = (dates: string[]) => dates.map((d, i) => ({ date: d, close: 100 + i }));

describe("pickFreshestProvider", () => {
  it("returns the provider whose newest bar is latest", () => {
    const chosen = pickFreshestProvider([
      { provider: "massive", candles: bars(["2026-08-20", "2026-08-24"]) },
      { provider: "yahoo", candles: bars(["2026-08-20", "2026-08-31"]) },
    ]);
    expect(chosen?.provider).toBe("yahoo");
  });

  // The exact production shape: Massive has MORE bars but ends earlier.
  it("does not prefer the longer series when it is staler", () => {
    const chosen = pickFreshestProvider([
      { provider: "massive", candles: bars(Array.from({ length: 500 }, (_, i) =>
        new Date(Date.UTC(2024, 7, 26 + i)).toISOString().slice(0, 10)).filter(d => d <= "2026-08-24")) },
      { provider: "yahoo", candles: bars(["2026-08-28", "2026-08-31"]) },
    ]);
    expect(chosen?.provider).toBe("yahoo");
  });

  it("keeps the preferred provider on a tie", () => {
    const chosen = pickFreshestProvider([
      { provider: "massive", candles: bars(["2026-08-31"]) },
      { provider: "yahoo", candles: bars(["2026-08-31"]) },
    ]);
    expect(chosen?.provider).toBe("massive");
  });

  it("ignores empty providers and returns null when all are empty", () => {
    expect(pickFreshestProvider([
      { provider: "massive", candles: [] },
      { provider: "yahoo", candles: bars(["2026-08-31"]) },
    ])?.provider).toBe("yahoo");
    expect(pickFreshestProvider([
      { provider: "massive", candles: [] }, { provider: "yahoo", candles: [] },
    ])).toBeNull();
  });
});

describe("newestBarDate", () => {
  it("finds the maximum date regardless of input order", () => {
    expect(newestBarDate(bars(["2026-08-31", "2026-08-20", "2026-08-24"]))).toBe("2026-08-31");
  });
  it("returns null for an empty series", () => {
    expect(newestBarDate([])).toBeNull();
  });
});
