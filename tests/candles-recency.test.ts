import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchUsCandles, newestBarIsStale } from "@/lib/data/candles";
vi.mock("@/lib/data/provider-fetch", () => ({ providerCachedFetch: vi.fn() }));
import { providerCachedFetch } from "@/lib/data/provider-fetch";

function bar(date: string) {
  return { date, open: 100, high: 110, low: 90, close: 105, volume: 1000000 };
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe("newestBarIsStale", () => {
  it("empty series is stale", () => {
    expect(newestBarIsStale([])).toBe(true);
  });

  it("today's bar is fresh", () => {
    expect(newestBarIsStale([bar(daysAgo(0))])).toBe(false);
  });

  it("yesterday's bar is fresh", () => {
    expect(newestBarIsStale([bar(daysAgo(1))])).toBe(false);
  });

  it("3-day-old bar is fresh (long weekend)", () => {
    expect(newestBarIsStale([bar(daysAgo(3))])).toBe(false);
  });

  it("4-day-old bar is fresh (edge of window)", () => {
    expect(newestBarIsStale([bar(daysAgo(4))])).toBe(false);
  });

  it("5-day-old bar is stale (the Massive cache bug scenario)", () => {
    expect(newestBarIsStale([bar(daysAgo(5))])).toBe(true);
  });

  it("uses only the last bar in the series", () => {
    const series = [bar(daysAgo(30)), bar(daysAgo(10)), bar(daysAgo(1))];
    expect(newestBarIsStale(series)).toBe(false);
  });

  it("stale if all bars are old", () => {
    const series = [bar(daysAgo(20)), bar(daysAgo(10)), bar(daysAgo(6))];
    expect(newestBarIsStale(series)).toBe(true);
  });
});

describe("post-close required session fallback", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.mocked(providerCachedFetch).mockReset(); });

  it("continues to another provider when a long-weekend-fresh source lacks the required bar", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    vi.stubEnv("MASSIVE_API_KEY", "test-only");
    vi.mocked(providerCachedFetch).mockImplementation(async (provider) => provider === "yahoo"
      ? { chart: { result: [{ timestamp: [Date.UTC(2026, 9, 20) / 1000], indicators: {
        quote: [{ open: [100], high: [110], low: [90], close: [105], volume: [1] }],
      } }] } }
      : { results: [{ t: Date.UTC(2026, 9, 21), o: 100, h: 110, l: 90, c: 105, v: 1 }] });
    const result = await fetchUsCandles("TEST", async () => [], 1, { forceRefresh: true, requiredSession: "2026-10-21" });
    expect(result.source).toBe("massive");
    expect(result.candles.at(-1)?.date).toBe("2026-10-21");
  });

  it("does not exempt the final fallback from required-session validation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    vi.mocked(providerCachedFetch).mockResolvedValue({});
    const result = await fetchUsCandles("TEST", async () => [bar("2026-10-20")], 1, { requiredSession: "2026-10-21" });
    expect(result.source).toBe("unavailable");
  });
});
