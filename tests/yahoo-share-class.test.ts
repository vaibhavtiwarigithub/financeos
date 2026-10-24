import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/data/provider-fetch", () => ({ providerCachedFetch: vi.fn(async () => ({})) }));
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { fetchYahooCandles } from "@/lib/data/candles";
import { yahooChartSymbol } from "@/lib/data/yahoo-symbol";
afterEach(() => vi.mocked(providerCachedFetch).mockClear());
describe("Yahoo share-class translation", () => {
  it.each([["BRK.B", "BRK-B"], ["BF.B", "BF-B"], ["HEI.A", "HEI-A"],
    ["SUNT V.NS", "SUNT V.NS"], ["SUNTV.NS", "SUNTV.NS"], ["BSE.BO", "BSE.BO"], ["AAPL", "AAPL"], ["^NSEI", "^NSEI"]])("maps %s only on the provider boundary", (symbol, expected) => {
    expect(yahooChartSymbol(symbol)).toBe(expected);
  });
  it("preserves the canonical cache key and forced-refresh contract", async () => {
    await fetchYahooCandles("BRK.B", true);
    expect(providerCachedFetch).toHaveBeenCalledWith("yahoo", "YAHOO_CANDLES:BRK.B",
      expect.stringContaining("/BRK-B?"), { timeoutMs: 8000, forceRefresh: true });
  });
});
