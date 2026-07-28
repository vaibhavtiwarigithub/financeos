import { describe, it, expect } from "vitest";
import { yahooRange } from "./yahoo-candles";

describe("yahooRange", () => {
  it("maps day depths to the smallest covering Yahoo range", () => {
    expect(yahooRange(30)).toBe("1y");
    expect(yahooRange(365)).toBe("1y");
    expect(yahooRange(366)).toBe("2y");
    expect(yahooRange(730)).toBe("2y");
    expect(yahooRange(731)).toBe("3y");
    expect(yahooRange(1095)).toBe("3y");
    expect(yahooRange(1096)).toBe("5y");
    expect(yahooRange(1825)).toBe("5y");
    expect(yahooRange(1826)).toBe("10y");
  });

  it("does not under-serve the resolveCandles default (regression)", () => {
    // US_DAYS_DEFAULT is 420. The inherited indiaRange returned "1y" (~247
    // sessions) for that, below the 273 sessions 12-1 momentum needs, so India
    // mom_12_1 was computed on truncated history at the default depth.
    expect(yahooRange(420)).toBe("2y");
  });

  it("covers the depths the promotion power analysis needs", () => {
    // Annex A/B: ~3 years of daily candles for a 20-day horizon with a 252-day
    // feature lookback. Anything that silently returned 1y here would starve the
    // fold engine of as-of dates.
    expect(yahooRange(1095)).toBe("3y");
    expect(yahooRange(1825)).toBe("5y");
  });

  it("never returns a range shorter than the days requested", () => {
    const floorDays: Record<string, number> = { "1y": 365, "2y": 730, "3y": 1095, "5y": 1825, "10y": 3650 };
    for (const days of [100, 400, 600, 800, 1000, 1200, 1500, 2000, 2900, 3200]) {
      expect(floorDays[yahooRange(days)]).toBeGreaterThanOrEqual(days);
    }
  });
});
