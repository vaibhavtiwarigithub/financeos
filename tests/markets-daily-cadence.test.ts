import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCachedSessions, resolveSymbolPair } from "@/lib/markets/price-cache-sessions";

const ROOT = resolve(__dirname, "..");

describe("resolveCachedSessions", () => {
  const bars = [
    { symbol: "SPY", date: "2026-09-11", close: 100 },
    { symbol: "XLK", date: "2026-09-11", close: 50 },
    { symbol: "SPY", date: "2026-09-10", close: 98 },
    { symbol: "XLK", date: "2026-09-10", close: 52 },
    { symbol: "SPY", date: "2026-09-09", close: 95 },
  ];

  it("picks the two newest sessions present in the data", () => {
    const out = resolveCachedSessions(bars)!;
    expect(out.latest.date).toBe("2026-09-11");
    expect(out.prior.date).toBe("2026-09-10");
    expect(out.latest.closes.get("SPY")).toBe(100);
    expect(out.prior.closes.get("XLK")).toBe(52);
  });

  it("resolves sessions from the data, so a weekend or holiday gap needs no calendar", () => {
    // Fri 09-11 then Mon 09-14 (09-12/13 weekend, and 09-14 would be skipped if
    // unfilled). Whatever is present is what gets compared.
    const out = resolveCachedSessions([
      { symbol: "SPY", date: "2026-09-15", close: 101 },
      { symbol: "SPY", date: "2026-09-11", close: 100 },
    ])!;
    expect(out.latest.date).toBe("2026-09-15");
    expect(out.prior.date).toBe("2026-09-11");
  });

  it("ignores null and non-finite closes rather than treating them as zero", () => {
    const out = resolveCachedSessions([
      { symbol: "SPY", date: "2026-09-11", close: null },
      { symbol: "SPY", date: "2026-09-10", close: 98 },
      { symbol: "SPY", date: "2026-09-09", close: 95 },
    ])!;
    expect(out.latest.date).toBe("2026-09-10");
    expect(out.latest.closes.has("SPY")).toBe(true);
  });

  it("returns null rather than inventing a comparison from one session", () => {
    expect(resolveCachedSessions([{ symbol: "SPY", date: "2026-09-11", close: 100 }])).toBeNull();
    expect(resolveCachedSessions([])).toBeNull();
  });
});

describe("resolveSymbolPair", () => {
  it("returns the newest close and the one before it regardless of row order", () => {
    const out = resolveSymbolPair([
      { symbol: "TQQQ", date: "2026-09-10", close: 40 },
      { symbol: "TQQQ", date: "2026-09-11", close: 42 },
    ])!;
    expect(out.close).toBe(42);
    expect(out.date).toBe("2026-09-11");
    expect(out.priorClose).toBe(40);
  });

  it("reports a missing prior close as null rather than zero", () => {
    const out = resolveSymbolPair([{ symbol: "TQQQ", date: "2026-09-11", close: 42 }])!;
    expect(out.priorClose).toBeNull();
  });

  it("returns null when nothing is cached", () => {
    expect(resolveSymbolPair([])).toBeNull();
  });
});

// The two markets routes reach once-a-day cadence by DIFFERENT means, because
// they have different constraints:
//
//   /api/markets/quotes   — cache-only. It is per-symbol with no cross-symbol
//                           alignment requirement, and its provider path
//                           computed an INTRADAY move (c - o) while the cached
//                           path computes the true daily change, so reading the
//                           cache is both cheaper and more correct.
//
//   /api/markets/overview — keeps the grouped provider as its source. Reading
//                           price_cache there was tried and rejected on
//                           production evidence (tests/markets-overview.test.ts,
//                           2026-07-17): a ragged cache head makes its newest
//                           ALIGNED session staler than grouped and re-opens
//                           cross-session mixing. Its cadence is fixed by a
//                           durable per-session snapshot instead.
describe("markets cadence contracts", () => {
  it("/api/markets/quotes is cache-only — no outbound call at all", () => {
    const src = readFileSync(resolve(ROOT, "app/api/markets/quotes/route.ts"), "utf8");
    expect(src.includes("https://"), "quotes contains an outbound URL").toBe(false);
    expect(/\bfetch\s*\(/.test(src), "quotes calls fetch()").toBe(false);
    expect(/MASSIVE|ALPHA_VANTAGE|apiKey/.test(src), "quotes references a provider key").toBe(false);
  });

  it("/api/markets/overview keeps the grouped source but stays snapshot-guarded", () => {
    const src = readFileSync(resolve(ROOT, "app/api/markets/overview/route.ts"), "utf8");
    // The source is deliberately still the provider...
    expect(src.includes("aggs/grouped")).toBe(true);
    // ...so the per-session snapshot is what stops it resolving per request.
    expect(src.includes("market_overview_snapshots"), "overview lost its durable snapshot").toBe(true);
    expect(src.includes("readSnapshot"), "overview no longer reads the snapshot").toBe(true);
    expect(src.includes("writeSnapshot"), "overview no longer stores the snapshot").toBe(true);
    expect(src.includes("expectedLatestSessionDate"), "overview no longer checks snapshot staleness").toBe(true);
  });
});
