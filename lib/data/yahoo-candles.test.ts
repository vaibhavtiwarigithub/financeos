import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchYahooCandles, fetchYahooRawReplaySeries, yahooRange } from "./yahoo-candles";

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

describe("fetchYahooCandles adjustment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses adjusted close only when explicitly requested", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            timestamp: [1_700_000_000],
            indicators: {
              quote: [{
                open: [100], high: [110], low: [90], close: [100], volume: [123],
              }],
              adjclose: [{ adjclose: [50] }],
            },
          }],
        },
      }),
    }));

    const raw = await fetchYahooCandles("TEST", "1y");
    const adjusted = await fetchYahooCandles("TEST", "1y", { adjusted: true });
    expect(raw[0]).toMatchObject({ open: 100, high: 110, low: 90, close: 100, volume: 123 });
    expect(adjusted[0]).toMatchObject({ open: 50, high: 55, low: 45, close: 50, volume: 123 });
  });

  it("fails closed when an adjusted study cannot obtain adjusted close", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            timestamp: [1_700_000_000],
            indicators: {
              quote: [{ open: [100], high: [110], low: [90], close: [100], volume: [123] }],
            },
          }],
        },
      }),
    }));
    expect(await fetchYahooCandles("TEST", "1y", { adjusted: true })).toEqual([]);
  });
});

describe("fetchYahooRawReplaySeries", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns coherent raw OHLC and explicit corporate actions from one response", async () => {
    const splitDate = Date.UTC(2026, 0, 5) / 1000;
    const dividendDate = Date.UTC(2026, 0, 6) / 1000;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ chart: { result: [{
        timestamp: [Date.UTC(2026, 0, 5) / 1000, Date.UTC(2026, 0, 6) / 1000],
        indicators: {
          quote: [{ open: [100, 50], high: [105, 52], low: [98, 49], close: [102, 51], volume: [10, 20] }],
          adjclose: [{ adjclose: [50, 25] }],
        },
        events: {
          splits: { [splitDate]: { date: splitDate, numerator: 2, denominator: 1, splitRatio: "2:1" } },
          dividends: { [dividendDate]: { date: dividendDate, amount: 0.25 } },
        },
      }] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const series = await fetchYahooRawReplaySeries("xyz", "1y");

    expect(series).toMatchObject({ source: "yahoo_chart_v8", priceBasis: "raw_ohlc", actionsRequested: true });
    expect(series?.candles[0]).toMatchObject({ date: "2026-01-05", open: 100, high: 105, low: 98, close: 102 });
    expect(series?.corporateActions).toEqual([
      { symbol: "XYZ", session: "2026-01-05", type: "split", splitRatio: 2 },
      { symbol: "XYZ", session: "2026-01-06", type: "dividend", dividendPerShare: 0.25 },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain("events=div%2Csplits");
  });

  it("fails closed on missing or internally invalid OHLC", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ chart: { result: [{
        timestamp: [Date.UTC(2026, 0, 5) / 1000],
        indicators: { quote: [{ open: [100], high: [95], low: [90], close: [92], volume: [10] }] },
      }] } }),
    }));
    expect(await fetchYahooRawReplaySeries("XYZ")).toBeNull();
  });
});
