import { describe, expect, it } from "vitest";
import { parseAlpacaDailyBars } from "@/lib/data/alpaca-market-data";

describe("parseAlpacaDailyBars", () => {
  it("normalizes IEX bars to US session dates and sorts them", () => {
    const bars = parseAlpacaDailyBars({ bars: [
      { t: "2026-10-16T04:00:00Z", o: 101, h: 105, l: 99, c: 104, v: 200 },
      { t: "2026-10-15T04:00:00Z", o: 98, h: 102, l: 97, c: 101, v: 150 },
    ] });
    expect(bars.map((bar) => bar.date)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(bars[1]).toMatchObject({ open: 101, high: 105, low: 99, close: 104, volume: 200 });
  });

  it("rejects malformed and impossible OHLC rows", () => {
    const bars = parseAlpacaDailyBars({ bars: [
      { t: "bad", o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: "2026-10-16T04:00:00Z", o: 101, h: 100, l: 99, c: 104, v: 1 },
      { t: "2026-10-16T04:00:00Z", o: 101, h: 105, l: 99, c: 104, v: 1 },
    ] });
    expect(bars).toHaveLength(1);
  });
});
