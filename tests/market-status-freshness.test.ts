import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/av-cache", () => ({ avCachedFetch: mocks.fetch }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.read }) }) }) }),
}) }));

const NOW = "2026-10-27T16:00:00Z";
const payload = (status: string) => ({ markets: [{ market_type: "Equity", region: "United States", current_status: status }] });
const observation = (fetched_at: string | null, status = "closed") => ({ data: { fetched_at, payload: payload(status) }, error: null });

describe("live market status observation freshness", () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
    vi.stubEnv("ALPHA_VANTAGE_API_KEY", "test-only-not-a-credential");
    mocks.fetch.mockReset().mockResolvedValue(payload("closed"));
    mocks.read.mockReset().mockResolvedValue(observation(NOW));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("does not reuse India's overnight US-closed observation as a midday veto", async () => {
    mocks.read.mockResolvedValue(observation("2026-10-27T04:00:02Z"));
    const { isMarketOpenLive } = await import("@/lib/trading/market-calendar");
    expect(await isMarketOpenLive("us")).toMatchObject({ open: true, reason: expect.stringContaining("live status unavailable") });
  });

  it("preserves a genuinely fresh closed veto", async () => {
    const { isMarketOpenLive } = await import("@/lib/trading/market-calendar");
    expect(await isMarketOpenLive("us")).toMatchObject({ open: false, reason: expect.stringContaining("MARKET_STATUS=closed") });
  });

  it.each([null, "invalid", "2026-10-27T16:00:01Z", "2026-10-27T15:55:00Z"])("does not trust missing, future or expired provenance: %s", async (timestamp) => {
    mocks.read.mockResolvedValue(observation(timestamp));
    const { isMarketOpenLive } = await import("@/lib/trading/market-calendar");
    expect(await isMarketOpenLive("us")).toMatchObject({ open: true, reason: expect.stringContaining("live status unavailable") });
  });

  it("uses the payload paired with the stored timestamp, rather than a mismatched fetch result", async () => {
    mocks.read.mockResolvedValue(observation(NOW, "open"));
    const { isMarketOpenLive } = await import("@/lib/trading/market-calendar");
    expect(await isMarketOpenLive("us")).toMatchObject({ open: true, reason: "AV MARKET_STATUS=open" });
  });

  it("does not renew an observation's five-minute life on a memory hit", async () => {
    mocks.read.mockResolvedValue(observation("2026-10-27T15:56:00Z"));
    const { isMarketOpenLive } = await import("@/lib/trading/market-calendar");
    expect((await isMarketOpenLive("us")).open).toBe(false);
    vi.setSystemTime(new Date("2026-10-27T16:00:30Z"));
    expect((await isMarketOpenLive("us")).open).toBe(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-27T16:01:00Z"));
    expect((await isMarketOpenLive("us")).open).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts an observation that arrives during the provider fetch", async () => {
    mocks.fetch.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-10-27T16:00:00.800Z"));
      return payload("closed");
    });
    mocks.read.mockResolvedValue(observation("2026-10-27T16:00:00.500Z"));
    const { isMarketOpenLive } = await import("@/lib/trading/market-calendar");
    expect((await isMarketOpenLive("us")).open).toBe(false);
  });

  it("leaves status unknown when its persisted provenance cannot be read", async () => {
    mocks.read.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    const { isMarketOpenLive } = await import("@/lib/trading/market-calendar");
    expect((await isMarketOpenLive("us")).reason).toContain("live status unavailable");
  });

  it.each(["2026-10-27T04:00:00Z", "2026-10-25T16:00:00Z", "2026-11-26T16:00:00Z"])("keeps the local closure gate without a provider call: %s", async (timestamp) => {
    vi.setSystemTime(new Date(timestamp));
    const { isMarketOpenLive } = await import("@/lib/trading/market-calendar");
    expect((await isMarketOpenLive("us")).open).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
