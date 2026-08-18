import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-18: EODHD's free-tier budget (20/day) was being exhausted every run.
// Cause: Massive per-symbol candles are PACED at 12.5s (5/min), so a ~300-symbol
// EdgeScout run gets most Massive calls refused and cascades into the budgeted
// providers. Measured 2026-08-17 — Massive resolved 12, EODHD exactly 20 (its
// cap), TwelveData 24; everything past that returned `unavailable`.
//
// Yahoo carries NO daily budget and already serves the India branch of the same
// function. It is added as a LAST RESORT: strictly additive, so no symbol that
// resolves today changes source or value. Moving it EARLIER would cut budget
// spend but change which provider serves a symbol — and therefore the IC written
// to edge_ic_history, which lib/gates/promotion-gate.ts reads. Out of scope here.

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

describe("US edge candles: Yahoo is a last resort, never a reorder", () => {
  it("rescues a symbol every budgeted provider failed on — previously 'unavailable'", async () => {
    yahoo.mockResolvedValue(bars(400));
    const r = await resolveCandles("AAPL", "us", 420);
    expect(r.source).toBe("yahoo_us_last_resort");
    expect(r.candles).toHaveLength(400);
    // It ran only after all three budgeted providers were exhausted.
    expect(massive).toHaveBeenCalledOnce();
    expect(eodhd).toHaveBeenCalledOnce();
    expect(twelve).toHaveBeenCalledOnce();
  });

  it("does NOT change a symbol Massive already serves — no reorder, no extra call", async () => {
    massive.mockResolvedValue(bars(300));
    const r = await resolveCandles("NVDA", "us", 420);
    expect(r.source).toBe("massive");
    expect(eodhd).not.toHaveBeenCalled();
    expect(twelve).not.toHaveBeenCalled();
    expect(yahoo).not.toHaveBeenCalled();
  });

  it("leaves the EODHD and TwelveData branches intact", async () => {
    eodhd.mockResolvedValue(bars(300));
    expect((await resolveCandles("AMD", "us", 420)).source).toBe("eodhd");
    expect(yahoo).not.toHaveBeenCalled();

    eodhd.mockResolvedValue([]);
    twelve.mockResolvedValue(bars(300));
    expect((await resolveCandles("MU", "us", 420)).source).toBe("twelvedata");
    expect(yahoo).not.toHaveBeenCalled();
  });

  it("still reports 'unavailable' when even Yahoo has nothing — no invented series", async () => {
    const r = await resolveCandles("DELISTED", "us", 420);
    expect(r.source).toBe("unavailable");
    expect(r.candles).toEqual([]);
  });

  it("India is untouched — one Yahoo call, no US ladder", async () => {
    yahoo.mockResolvedValue(bars(300));
    const r = await resolveCandles("TCS.NS", "india", 420);
    expect(r.source).toBe("yahoo_india");
    expect(massive).not.toHaveBeenCalled();
    expect(eodhd).not.toHaveBeenCalled();
  });
});
