import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchYahooOverview, providerCachedFetch } = vi.hoisted(() => ({
  fetchYahooOverview: vi.fn(),
  providerCachedFetch: vi.fn(),
}));

vi.mock("@/lib/india-data", () => ({
  fetchIndiaOverview: fetchYahooOverview,
}));

vi.mock("@/lib/data/provider-fetch", () => ({
  providerCachedFetch,
}));

import { fetchUsOverview } from "@/lib/data/fundamentals";

describe("US fundamentals resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
  });

  it("uses ADS-compatible Yahoo data for a reviewed ADR and does not invoke AV fallback", async () => {
    fetchYahooOverview.mockResolvedValue({ Symbol: "SKHY", PERatio: "20.5", EPS: "7" });
    const avFallback = vi.fn().mockResolvedValue({ Symbol: "SKHY", PERatio: "12.8", EPS: "105907" });

    const result = await fetchUsOverview("SKHY", avFallback, { isAdr: true, maxAgeDays: 1 });

    expect(result).toEqual({
      source: "yahoo",
      overview: { Symbol: "SKHY", PERatio: "20.5", EPS: "7" },
    });
    expect(fetchYahooOverview).toHaveBeenCalledWith("SKHY", { maxAgeDays: 1 });
    expect(avFallback).not.toHaveBeenCalled();
  });

  it("fails unavailable instead of using a foreign-underlying fallback for a thin ADR response", async () => {
    fetchYahooOverview.mockResolvedValue({ Symbol: "SKHY" });
    const avFallback = vi.fn().mockResolvedValue({ Symbol: "SKHY", PERatio: "12.8", EPS: "105907" });

    await expect(fetchUsOverview("SKHY", avFallback, { isAdr: true })).resolves.toEqual({
      source: "unavailable",
      overview: {},
    });
    expect(avFallback).not.toHaveBeenCalled();
    expect(providerCachedFetch).not.toHaveBeenCalled();
  });
});
