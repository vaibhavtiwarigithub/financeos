// W9 detectors — the remaining `price_cache` consumers.
//
// Governing principle (REMEDIATION_PLAN §0): every fix ships with a check that
// FAILS when the fix regresses. These are those checks. Each one is written
// against the ACTUAL production shape — a cache frozen at 2026-07-22 for 101 of
// 140 symbols — not against a synthetic edge case.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isFreshSessionDate,
  priceCacheCandidate,
  assertFreshBar,
  assessSeries,
} from "@/lib/data/price-cache-freshness";
import { estimateDailyVolPctDetailed } from "@/lib/portfolio/inputs";
import { getBenchmarkSeries, getBenchmarkSeriesStatus, __resetBenchmarkCache } from "@/lib/data/benchmark-series";

// A Wednesday. Weekday, no US holiday — so "last completed session" is Tuesday
// 2026-08-11 and anything at or after that is current.
const NOW = new Date("2026-08-12T14:00:00Z");

/** The date 101 of 140 symbols were stuck at when the incident was found. */
const FROZEN = "2026-07-22";

/** Minimal supabase double: one chained query returning a fixed row set. */
function fakeSupabase(rows: any[] | null) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows }),
  };
  return { from: () => chain };
}

/** A dense, perfectly-shaped 21-bar window ending on `endDate`, walking backwards. */
function window21(endDate: string, startClose = 100): { date: string; close: number }[] {
  const out: { date: string; close: number }[] = [];
  const cursor = new Date(`${endDate}T00:00:00Z`);
  let close = startClose;
  while (out.length < 21) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push({ date: cursor.toISOString().slice(0, 10), close: Number(close.toFixed(2)) });
      close *= 0.99; // real dispersion, so a passing case really does measure vol
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out; // date-desc, exactly as the route's `.order("date", desc)` returns
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetBenchmarkCache();
});

function freezeClock() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

// ── The rule itself ─────────────────────────────────────────────────────────

describe("price_cache freshness derives from the BAR'S MARKET DATE", () => {
  it("accepts the last completed session and rejects the frozen date", () => {
    expect(isFreshSessionDate("2026-08-11", "us", NOW)).toBe(true);
    expect(isFreshSessionDate(FROZEN, "us", NOW)).toBe(false);
  });

  it("accepts today's provisional bar without future-dating its provenance", () => {
    // The bar's nominal 20:00Z close has not happened yet at 14:00Z. A naive
    // `date + T20:00:00Z` would be future-dated and assertFreshQuote would reject
    // it as timestamp_invalid — a false rejection of the FRESHEST bar we hold.
    const c = priceCacheCandidate({ date: "2026-08-12", close: 100 }, "us", NOW);
    expect(Date.parse(c.retrievedAt!)).toBeLessThanOrEqual(NOW.getTime());
    expect(c.stale).toBe(false);
    expect(assertFreshBar({ date: "2026-08-12", close: 100 }, "SPY", "us", NOW).ok).toBe(true);
  });

  it("REGRESSION GUARD: `cached_at` must never be the input to the rule", () => {
    // supabase/functions/_shared/quotes.ts used `cached_at ?? date` and treated
    // ALL off-hours cache as fresh. Re-reading a fossil row today does not make
    // it fresh; the bar's date is the only thing that decides.
    const verdict = assertFreshBar({ date: FROZEN, close: 391.97 }, "MSFT", "us", NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("quote_stale");
  });

  it("rejects a malformed or missing date rather than defaulting to fresh", () => {
    expect(isFreshSessionDate("not-a-date", "us", NOW)).toBe(false);
    expect(assertFreshBar(null, "AAPL", "us", NOW).ok).toBe(false);
    expect(assertFreshBar({ date: "2026-08-11", close: 0 }, "AAPL", "us", NOW).ok).toBe(false);
  });
});

describe("assessSeries — coverage and freshness are separate failures", () => {
  it("passes a dense, current window", () => {
    const r = assessSeries(window21("2026-08-11"), { symbol: "AAPL", minBars: 15, now: NOW });
    expect(r).toMatchObject({ ok: true, reason: "ok", asOf: "2026-08-11", bars: 21 });
  });

  it("fails a DENSE but FROZEN window — the exact production shape", () => {
    const r = assessSeries(window21(FROZEN), { symbol: "MSFT", minBars: 15, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stale_series");
    expect(r.bars).toBe(21); // plenty of data; all of it dead
  });

  it("fails a CURRENT but THIN window", () => {
    const r = assessSeries(window21("2026-08-11").slice(0, 6), { symbol: "AAPL", minBars: 15, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient_coverage");
  });
});

// ── Consumer 1: PaperTrader position sizing ─────────────────────────────────

describe("estimateDailyVolPct — a frozen window must not yield a confident vol", () => {
  it("measures vol from a fresh window", async () => {
    freezeClock();
    const r = await estimateDailyVolPctDetailed("AAPL", "us", fakeSupabase(window21("2026-08-11")));
    expect(r.basis).toBe("measured");
    expect(r.reason).toBe("ok");
    expect(r.vol).toBeGreaterThan(0);
    expect(r.asOf).toBe("2026-08-11");
  });

  it("THE W9 REGRESSION: a frozen 21-close window falls back to the default, explicitly", async () => {
    freezeClock();
    // Before W9 this returned a real-looking stdev off Jun–Jul closes and fed it
    // straight into position sizing — permanently, since the window never moves.
    const r = await estimateDailyVolPctDetailed("MSFT", "us", fakeSupabase(window21(FROZEN)));
    expect(r.basis).toBe("default");        // NOT a measurement
    expect(r.reason).toBe("stale_series");  // and it says why
    expect(r.vol).toBe(0.02);
    expect(r.asOf).toBe(FROZEN);            // observable: the fossil date is reported
    expect(r.bars).toBe(21);
  });

  it("falls back explicitly on thin coverage and on no data at all", async () => {
    freezeClock();
    const thin = await estimateDailyVolPctDetailed("XYZ", "us", fakeSupabase(window21("2026-08-11").slice(0, 5)));
    expect(thin).toMatchObject({ basis: "default", reason: "insufficient_coverage" });

    const none = await estimateDailyVolPctDetailed("XYZ", "us", fakeSupabase([]));
    expect(none).toMatchObject({ basis: "default", reason: "no_data", vol: 0.02 });
  });

  it("refuses a zero-dispersion window — 0 vol reads as infinite position size", async () => {
    freezeClock();
    const flat = window21("2026-08-11").map((b) => ({ ...b, close: 100 }));
    const r = await estimateDailyVolPctDetailed("FLAT", "us", fakeSupabase(flat));
    expect(r).toMatchObject({ basis: "default", reason: "undispersed", vol: 0.02 });
  });

  it("keeps the bare-number signature PaperTrader depends on", async () => {
    freezeClock();
    const { estimateDailyVolPct } = await import("@/lib/portfolio/inputs");
    const v = await estimateDailyVolPct("MSFT", "us", fakeSupabase(window21(FROZEN)));
    expect(typeof v).toBe("number");
    expect(v).toBe(0.02);
  });
});

// ── Consumer 2: benchmark series (beta / RS) ────────────────────────────────

describe("benchmark series — a stale SPY is reported stale, not silently used", () => {
  it("returns a fresh series with its as-of date", async () => {
    freezeClock();
    const bars = window21("2026-08-11").concat(window21("2026-07-10", 90)).concat(window21("2026-06-10", 80));
    const status = await getBenchmarkSeriesStatus("us", fakeSupabase(bars));
    expect(status.stale).toBe(false);
    expect(status.reason).toBe("ok");
    expect(status.asOf).toBe("2026-08-11");
    expect(status.bars.length).toBeGreaterThanOrEqual(60);
  });

  it("THE W9 REGRESSION: a frozen SPY series is stale, and getBenchmarkSeries yields []", async () => {
    freezeClock();
    // 63 dense bars, all of them ending 2026-07-22. Before W9 this produced a
    // beta and an RS that looked measured and were fossils.
    const bars = window21(FROZEN).concat(window21("2026-06-22", 90)).concat(window21("2026-05-22", 80));
    const supa = fakeSupabase(bars);

    const status = await getBenchmarkSeriesStatus("us", supa);
    expect(status.stale).toBe(true);
    expect(status.reason).toBe("stale_series");
    expect(status.asOf).toBe(FROZEN);
    expect(status.bars.length).toBeGreaterThan(0); // the data is there; it is just dead

    __resetBenchmarkCache();
    // Callers read [] as "beta unmeasurable" — the honest reading of a frozen
    // benchmark, and why no caller needed to change.
    expect(await getBenchmarkSeries("us", supa)).toEqual([]);
  });

  it("an under-covered series is also unusable", async () => {
    freezeClock();
    const supa = fakeSupabase(window21("2026-08-11"));
    const status = await getBenchmarkSeriesStatus("us", supa);
    expect(status.stale).toBe(true);
    expect(status.reason).toBe("insufficient_coverage");
    __resetBenchmarkCache();
    expect(await getBenchmarkSeries("us", supa)).toEqual([]);
  });

  it("a failed read is empty and stale, never a partial series", async () => {
    freezeClock();
    const boom = { from: () => { throw new Error("db down"); } };
    const status = await getBenchmarkSeriesStatus("us", boom);
    expect(status).toMatchObject({ stale: true, reason: "no_data", asOf: null });
    expect(status.bars).toEqual([]);
  });
});

// ── Consumer 3: rescore-check (learner feedback) ────────────────────────────
//
// Source-level guards. The route's own logic is a handful of lines wrapped in a
// Next handler, and a test that re-implemented the selection would prove nothing.
// What IS worth pinning is that the two specific defects cannot come back — the
// same "architectural detector" pattern used by tests/risk-research-annotation.

describe("rescore-check cannot publish learner feedback off a fossil close", () => {
  const source = () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    return readFileSync(resolve(process.cwd(), "app/api/agents/rescore-check/route.ts"), "utf8");
  };

  it("validates the newest bar's as-of date through the shared rule", () => {
    const s = source();
    expect(s).toContain('from "@/lib/data/price-cache-freshness"');
    expect(s).toContain("isFreshSessionDate(currentRow.date");
    expect(s).toContain("stale_price_cache");
  });

  it("REGRESSION GUARD: never anchors on the oldest row when the signal date has no bar", () => {
    // `rows.find(r => r.date <= sigDay) ?? rows[rows.length - 1]` measured a window
    // that was not the signal's window, and published the result as feedback.
    expect(source()).not.toMatch(/\?\?\s*rows\[rows\.length\s*-\s*1\]/);
    expect(source()).toContain("no_bar_at_signal_date");
  });

  it("reports why nothing was evaluated instead of returning an empty all-clear", () => {
    const s = source();
    expect(s).toContain("skipped");
    expect(s).toContain("degraded");
  });
});

// ── Consumer 4: the divergent Deno rule ─────────────────────────────────────

describe("the second, weaker staleness rule is gone", () => {
  it("supabase/functions/_shared/quotes.ts no longer exists", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // It used `cached_at` and returned `stale: false` for ALL off-hours cache.
    // It had no importer; leaving it available for reuse was the hazard.
    expect(existsSync(resolve(process.cwd(), "supabase/functions/_shared/quotes.ts"))).toBe(false);
  });
});
