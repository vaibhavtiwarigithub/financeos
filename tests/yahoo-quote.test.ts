import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchYahooQuote } from "@/lib/india-data";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockYahooQuote(retrievedAt: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      chart: {
        result: [{
          meta: {
            regularMarketPrice: 100,
            regularMarketTime: Date.parse(retrievedAt) / 1000,
            chartPreviousClose: 99,
          },
        }],
      },
    }),
  }));
}

describe("Yahoo quote market-aware freshness", () => {
  it("accepts a same-session US close for PositionMonitor fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T21:00:00Z"));
    mockYahooQuote("2026-07-28T20:00:00Z");

    await expect(fetchYahooQuote("KO", "us")).resolves.toMatchObject({
      price: 100,
      stale: false,
    });
  });

  it("rejects a multi-day US close on the exit path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T21:00:00Z"));
    mockYahooQuote("2026-07-26T20:00:00Z");

    await expect(fetchYahooQuote("KO", "us")).resolves.toMatchObject({
      price: 100,
      stale: true,
    });
  });
});
