import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchYahooQuote } from "@/lib/india-data";

afterEach(() => vi.unstubAllGlobals());

describe("fetchYahooQuote day range", () => {
  it("carries regularMarketDayLow/High so the US monitor can detect intraday touches", async () => {
    const t = Math.floor(Date.now() / 1000);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 100, regularMarketTime: t, chartPreviousClose: 98, regularMarketDayLow: 97.5, regularMarketDayHigh: 101.2 } }] } }),
    })));
    const q = await fetchYahooQuote("AAA", "us");
    expect(q?.dayLow).toBe(97.5);
    expect(q?.dayHigh).toBe(101.2);
  });
  it("null when Yahoo omits the range", async () => {
    const t = Math.floor(Date.now() / 1000);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 100, regularMarketTime: t } }] } }),
    })));
    const q = await fetchYahooQuote("AAA", "us");
    expect(q?.dayLow).toBeNull();
    expect(q?.dayHigh).toBeNull();
  });
});
