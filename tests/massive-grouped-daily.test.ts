import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchMassiveGroupedDaily } from "@/lib/data/quotes";

/**
 * 2026-08-18. The deployed MASSIVE_API_KEY is 403 NOT_AUTHORIZED for every
 * /v2/snapshot endpoint, so the "primary batch path" returned zero US quotes on
 * every call — silently. The book fell through to a stale price_cache bar that
 * was mislabelled fresh: on 2026-08-17 all 13 US holdings were marked at
 * Friday's prices, overstating NAV by $57.79 and flipping the reported US
 * result from +0.24% to -0.34%.
 *
 * The grouped-daily endpoint IS entitled and returns the whole market in one
 * call. These pin its contract and, crucially, that failures are never
 * laundered into "no price for these symbols".
 */
const KEY = "test-key";
const orig = globalThis.fetch;
afterEach(() => { globalThis.fetch = orig; vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as any;
}

const row = (T: string, c: number, o = c, h = c, l = c) => ({ T, c, o, h, l, v: 1000, t: 1 });

describe("fetchMassiveGroupedDaily", () => {
  it("maps only the requested symbols, carrying the session's OHLC", async () => {
    mockFetch(200, { results: [row("MSFT", 480.35, 478, 483, 477), row("NVDA", 225.01), row("ZZZZ", 9)] });
    const out = await fetchMassiveGroupedDaily("2026-08-17", ["MSFT", "NVDA"], KEY);

    expect(Object.keys(out).sort()).toEqual(["MSFT", "NVDA"]);
    expect(out.MSFT.price).toBe(480.35);
    // dayLow feeds the intraday-stop check — it must survive the move to grouped.
    expect(out.MSFT.dayLow).toBe(477);
    expect(out.MSFT.dayHigh).toBe(483);
    // Provenance is the bar's own session close, never when we read it.
    expect(out.MSFT.retrievedAt).toBe("2026-08-17T20:00:00Z");
    expect(out.MSFT.stale).toBe(false);
  });

  it("includes ETFs — XAR was the symbol the dead /markets/etfs pass never resolved", async () => {
    mockFetch(200, { results: [row("XAR", 294.87)] });
    const out = await fetchMassiveGroupedDaily("2026-08-17", ["XAR"], KEY);
    expect(out.XAR.price).toBe(294.87);
  });

  it("a 403 yields NO quotes rather than fabricated ones — and is not silent", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(403, { status: "NOT_AUTHORIZED" });
    const out = await fetchMassiveGroupedDaily("2026-08-17", ["MSFT"], KEY);

    expect(out).toEqual({});
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toContain("403");
  });

  it("a 200 with zero rows is 'session not published', not 'these have no price'", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(200, { results: [] });
    const out = await fetchMassiveGroupedDaily("2026-08-18", ["MSFT"], KEY);

    expect(out).toEqual({});
    expect(spy).toHaveBeenCalled();
  });

  it("refuses non-positive or non-finite closes instead of marking a position at zero", async () => {
    mockFetch(200, { results: [row("AAA", 0), row("BBB", -5), { T: "CCC", c: "nope" }] });
    const out = await fetchMassiveGroupedDaily("2026-08-17", ["AAA", "BBB", "CCC"], KEY);
    expect(out).toEqual({});
  });

  it("no API key means no call at all", async () => {
    const f = vi.fn();
    globalThis.fetch = f as any;
    expect(await fetchMassiveGroupedDaily("2026-08-17", ["MSFT"], "")).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });
});
