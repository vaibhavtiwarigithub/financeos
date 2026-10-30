import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { instrument_key: "NSE_EQ|TEST" }, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/data/provider-fetch", () => ({ providerCachedFetch: h.fetch }));

import { fetchUpstoxCandles } from "@/lib/data/upstox";

describe("Upstox post-close candle refresh", () => {
  beforeEach(() => {
    vi.stubEnv("UPSTOX_ACCESS_TOKEN", "test-only-token");
    h.fetch.mockReset().mockResolvedValue({ status: "success", data: { candles: [
      ["2026-10-29T00:00:00+05:30", 10, 11, 9, 10.5, 100],
    ] } });
  });

  it("forces a real adapter fetch when the cache warmer requests it", async () => {
    const bars = await fetchUpstoxCandles("TEST.NS", 160, { forceRefresh: true });

    expect(bars).toEqual([{ date: "2026-10-29", open: 10, high: 11, low: 9, close: 10.5, volume: 100 }]);
    expect(h.fetch).toHaveBeenCalledWith("upstox", "UPSTOX_CANDLES:TEST:160", expect.any(String), expect.objectContaining({
      forceRefresh: true,
      timeoutMs: 8000,
    }));
  });

  it("keeps normal research calls cache-first unless explicitly forced", async () => {
    await fetchUpstoxCandles("TEST.NS");

    const options = h.fetch.mock.calls[0][3];
    expect(options).not.toHaveProperty("forceRefresh");
    expect(options).toMatchObject({ timeoutMs: 8000 });
  });
});
