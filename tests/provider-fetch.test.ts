import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  todayPayload: null as any,
  stalePayload: null as any,
  staleDate: "2026-07-10",
  staleSlotDate: null as string | null,
  budgetCount: 1 as number | null,
  budgetError: null as any,
  report: vi.fn(),
  resolve: vi.fn(),
  upserts: [] as any[],
}));

function serviceMock() {
  return {
    rpc: vi.fn(async () => ({ data: h.budgetCount, error: h.budgetError })),
    from: vi.fn((_table: string) => {
      const filters: Record<string, any> = {};
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: any) => { filters[k] = v; return chain; },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (filters.cache_date) return { data: h.todayPayload ? { payload: h.todayPayload } : null };
          return { data: h.stalePayload ? { payload: h.stalePayload, cache_date: h.staleSlotDate ?? h.staleDate, fetched_at: h.staleDate } : null };
        },
        upsert: (row: any) => {
          h.upserts.push(row);
          return { then: (ok: () => void) => ok() };
        },
      };
      return chain;
    }),
  };
}

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => serviceMock() }));
vi.mock("@/lib/system-health", () => ({
  reportIssue: (...a: any[]) => h.report(...a),
  resolveIssue: (...a: any[]) => h.resolve(...a),
}));

import { providerCachedFetch, providerConfig } from "@/lib/data/provider-fetch";

describe("providerCachedFetch free-tier and degradation contract", () => {
  beforeEach(() => {
    h.todayPayload = null; h.stalePayload = null; h.staleDate = new Date().toISOString(); h.staleSlotDate = null;
    h.budgetCount = 1; h.budgetError = null; h.report.mockReset(); h.resolve.mockReset(); h.upserts = [];
    vi.stubGlobal("fetch", vi.fn());
  });

  it("uses today's cache without spending budget or calling the provider", async () => {
    h.todayPayload = { cached: true };
    expect(await providerCachedFetch("alpha_vantage", "AV:X", "https://example.test")).toEqual({ cached: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed to recent stale cache when budget reservation errors", async () => {
    h.stalePayload = { stale: true }; h.budgetError = { message: "db unavailable" };
    expect(await providerCachedFetch("alpha_vantage", "AV:X", "https://example.test")).toEqual({ stale: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves stale cache and alerts when the free daily budget is exhausted", async () => {
    h.stalePayload = { stale: true }; h.budgetCount = 26;
    expect(await providerCachedFetch("alpha_vantage", "AV:X", "https://example.test")).toEqual({ stale: true });
    expect(h.report).toHaveBeenCalledOnce();
    expect(h.resolve).toHaveBeenCalledWith("provider-budget-pressure:alpha_vantage", expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to recent cache on a throttled provider response", async () => {
    h.stalePayload = { stale: true };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ Note: "rate limit" }), { status: 200 }));
    expect(await providerCachedFetch("alpha_vantage", "AV:X", "https://example.test")).toEqual({ stale: true });
  });

  it("does not reset stale slow-data age or exceed an event-sensitive fallback bound", async () => {
    h.stalePayload = { preEvent: true };
    h.staleDate = new Date(Date.now() - 3 * 86_400_000).toISOString();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ Note: "rate limit" }), { status: 200 }));

    expect(await providerCachedFetch("alpha_vantage", "AV:EVENT", "https://example.test", {
      maxAgeDays: 1,
      maxStaleAgeDays: 1,
    })).toBeNull();
    expect(h.upserts).toEqual([]);
  });

  it("returns a bounded slow-data fallback without carrying it into today's slot", async () => {
    h.stalePayload = { recent: true };
    h.staleDate = new Date(Date.now() - 12 * 60 * 60_000).toISOString();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ Note: "rate limit" }), { status: 200 }));

    expect(await providerCachedFetch("alpha_vantage", "AV:EVENT", "https://example.test", {
      maxAgeDays: 1,
      maxStaleAgeDays: 1,
    })).toEqual({ recent: true });
    expect(h.upserts).toEqual([]);
  });

  it("carries a today-only fallback forward with its original fetch time", async () => {
    h.stalePayload = { observations: ["2026-08-31"] };
    h.staleDate = new Date(Date.now() - 2 * 86_400_000).toISOString();
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 500 }));
    expect(await providerCachedFetch("fred", "FRED:DFII10:21", "https://example.test")).toEqual({ observations: ["2026-08-31"] });
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].fetched_at).toBe(h.staleDate);
  });

  it("stops serving a carried copy once the original fetch is past the stale bound", async () => {
    // Yesterday's slot, but the data inside it was really fetched 8 days ago.
    h.stalePayload = { observations: ["2026-08-31"] };
    h.staleSlotDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    h.staleDate = new Date(Date.now() - 8 * 86_400_000).toISOString();
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    expect(await providerCachedFetch("fred", "FRED:DFII10:21", "https://example.test")).toBeNull();
    expect(h.upserts).toEqual([]);
  });

  it("returns null rather than fabricated data when provider and cache both fail", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    expect(await providerCachedFetch("alpha_vantage", "AV:X", "https://example.test")).toBeNull();
  });

  it("defaults EODHD to its free 20-call daily tier", () => {
    expect(providerConfig().eodhd.dailyBudget).toBe(20);
  });
});
