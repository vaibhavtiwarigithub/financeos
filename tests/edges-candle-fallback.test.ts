import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-18: EODHD's free-tier budget (20/day) was being exhausted every run.
// Cause: Massive per-symbol candles are PACED at 12.5s (5/min), so a ~300-symbol
// EdgeScout run gets most Massive calls refused and cascades into the budgeted
// providers. Measured 2026-08-17 — Massive resolved 12, EODHD exactly 20 (its
// cap), TwelveData 24; everything past that returned `unavailable`.
//
// Yahoo carries NO daily budget, is unpaced, and already served the India branch
// of the same function. Owner-approved 2026-08-18 to go FIRST for US as well —
// build-order step 4 of features/walk-forward-ic-folds/. It also lifts the 2-year
// Massive lookback ceiling that made US walk-forward IC folds unbuildable
// (~12 usable as-of dates on 2y vs ~50 on Yahoo's 5y).
//
// This DOES change which provider serves a US symbol, and therefore the IC
// written to edge_ic_history that lib/gates/promotion-gate.ts reads. Taken
// deliberately, not as a drive-by: rows either side of 2026-08-18 are not
// like-for-like and must be segmented by providerCounts before comparison.

const massive = vi.fn();
const eodhd = vi.fn();
const twelve = vi.fn();
const yahoo = vi.fn();

vi.mock("@/lib/data/candles", () => ({
  fetchMassiveCandles: (...a: any[]) => massive(...a),
  fetchEodhdCandles: (...a: any[]) => eodhd(...a),
  fetchTwelveDataCandles: (...a: any[]) => twelve(...a),
}));
vi.mock("@/lib/data/yahoo-candles", () => ({
  fetchYahooCandles: (...a: any[]) => yahoo(...a),
  yahooRange: (d: number) => `${d}d`,
}));

const { resolveCandles } = await import("@/lib/edges/data");

const bars = (n: number) => Array.from({ length: n }, (_, i) => ({
  date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, open: 1, high: 1, low: 1, close: 1, volume: 1,
}));

beforeEach(() => {
  massive.mockReset(); eodhd.mockReset(); twelve.mockReset(); yahoo.mockReset();
  for (const m of [massive, eodhd, twelve, yahoo]) m.mockResolvedValue([]);
});

describe("US edge candles: Yahoo first", () => {
  it("serves US from Yahoo without touching any budgeted provider", async () => {
    yahoo.mockResolvedValue(bars(500));
    const r = await resolveCandles("AAPL", "us", 420);

    expect(r.source).toBe("yahoo_us");
    expect(r.candles).toHaveLength(500);
    // The whole point: the paced/capped providers are never reached.
    expect(massive).not.toHaveBeenCalled();
    expect(eodhd).not.toHaveBeenCalled();
    expect(twelve).not.toHaveBeenCalled();
  });

  it("asks Yahoo for a range that COVERS the request — 420d must not become 1y", async () => {
    yahoo.mockResolvedValue(bars(500));
    await resolveCandles("AAPL", "us", 420);
    // yahooRange(420) -> "2y"; a "1y" ask returns ~251 sessions, below the 273
    // that 12-1 momentum needs (252 + 21), which silently truncates the factor.
    expect(yahoo).toHaveBeenCalledWith("AAPL", "420d");
  });

  it("falls back through the budgeted ladder when Yahoo has nothing", async () => {
    massive.mockResolvedValue(bars(300));
    const r = await resolveCandles("NVDA", "us", 420);
    expect(r.source).toBe("massive");
    expect(yahoo).toHaveBeenCalledOnce();
    expect(eodhd).not.toHaveBeenCalled();
  });

  it("keeps EODHD and TwelveData reachable as later fallbacks", async () => {
    eodhd.mockResolvedValue(bars(300));
    expect((await resolveCandles("AMD", "us", 420)).source).toBe("eodhd");

    eodhd.mockResolvedValue([]);
    twelve.mockResolvedValue(bars(300));
    expect((await resolveCandles("MU", "us", 420)).source).toBe("twelvedata");
  });

  it("still reports 'unavailable' when every provider has nothing — no invented series", async () => {
    const r = await resolveCandles("DELISTED", "us", 420);
    expect(r.source).toBe("unavailable");
    expect(r.candles).toEqual([]);
  });

  it("US and India both resolve to Yahoo but stay separately labelled", async () => {
    yahoo.mockResolvedValue(bars(300));
    expect((await resolveCandles("TCS.NS", "india", 420)).source).toBe("yahoo_india");
    expect((await resolveCandles("AAPL", "us", 420)).source).toBe("yahoo_us");
    // providerCounts in lib/edges/ic.ts keys off these strings, so the source
    // change is attributable per run rather than silent.
    expect(massive).not.toHaveBeenCalled();
  });
});
