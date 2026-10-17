import { afterEach, describe, expect, it, vi } from "vitest";
import { getLeveragedIntradayQuote, parseLeveragedIntradayQuote } from "@/lib/data/leveraged-intraday-quotes";

vi.mock("@/lib/data/provider-fetch", () => ({ providerCachedFetch: vi.fn() }));
import { providerCachedFetch } from "@/lib/data/provider-fetch";

const now = new Date("2026-10-16T15:05:00.000Z");
const row = {
  symbol: "SOXL", close: "93.67", previous_close: "101.12", high: "103.92", low: "93.445",
  datetime: "2026-10-16", timestamp: Math.floor(now.getTime() / 1000) - 3600,
  last_quote_at: Math.floor(now.getTime() / 1000) - 30,
};

describe("leveraged intraday quote parsing", () => {
  it("uses the provider's last quote time, not the daily candle open or fetch time", () => {
    expect(parseLeveragedIntradayQuote("SOXL", row, now)).toMatchObject({
      source: "twelvedata", price: 93.67, observedAt: "2026-10-16T15:04:30.000Z",
      dayLow: 93.445, dayHigh: 103.92, bid: null, ask: null, stale: false,
    });
    expect(parseLeveragedIntradayQuote("SOXL", { ...row, last_quote_at: undefined }, now)).toBeNull();
  });

  it("rejects old, future, malformed, mismatched, and nonpositive observations", () => {
    expect(parseLeveragedIntradayQuote("SOXL", { ...row, last_quote_at: row.last_quote_at - 16 * 60 }, now)).toBeNull();
    expect(parseLeveragedIntradayQuote("SOXL", { ...row, last_quote_at: row.last_quote_at + 31 }, now)).toBeNull();
    expect(parseLeveragedIntradayQuote("SOXL", { ...row, last_quote_at: "yesterday" }, now)).toBeNull();
    expect(parseLeveragedIntradayQuote("SOXL", { ...row, symbol: "SOXS" }, now)).toBeNull();
    expect(parseLeveragedIntradayQuote("SOXL", { ...row, datetime: "2026-10-15" }, now)).toBeNull();
    expect(parseLeveragedIntradayQuote("SOXL", { ...row, close: "0" }, now)).toBeNull();
  });

  it("does not infer an executable spread from a last-trade quote", () => {
    const parsed = parseLeveragedIntradayQuote("SOXL", row, now);
    expect(parsed?.bid).toBeNull();
    expect(parsed?.ask).toBeNull();
  });
});

describe("leveraged quote source", () => {
  const originalKey = process.env.TWELVEDATA_API_KEY;
  afterEach(() => {
    if (originalKey == null) delete process.env.TWELVEDATA_API_KEY;
    else process.env.TWELVEDATA_API_KEY = originalKey;
    vi.mocked(providerCachedFetch).mockReset();
  });

  it("bypasses the day cache while retaining provider budget enforcement", async () => {
    process.env.TWELVEDATA_API_KEY = "test-key";
    vi.mocked(providerCachedFetch).mockResolvedValue({ ...row, last_quote_at: 1 });
    expect((await getLeveragedIntradayQuote("SOXL")).source).toBe("unavailable");
    expect(providerCachedFetch).toHaveBeenCalledWith(
      "twelvedata", "TD_INTRADAY_QUOTE:SOXL", expect.stringContaining("interval=1day"),
      expect.objectContaining({ forceRefresh: true, maxStaleAgeDays: 0 }),
    );
  });

  it("does not fetch without a configured key", async () => {
    delete process.env.TWELVEDATA_API_KEY;
    expect((await getLeveragedIntradayQuote("SOXL")).source).toBe("unavailable");
    expect(providerCachedFetch).not.toHaveBeenCalled();
  });
});
