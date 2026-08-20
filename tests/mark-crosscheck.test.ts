import { describe, it, expect } from "vitest";
import { buildPositionMark, MARK_CROSSCHECK_TOLERANCE_PCT, MARK_DISPUTE_REFUSE_PCT } from "@/lib/paper/marks";

/**
 * A mark drives stop and target evaluation, not just NAV, so a price no second
 * vendor will confirm must not silently move money.
 *
 * Motivating failure: Yahoo serves PROVISIONAL values it later retracts. On
 * 2026-08-18 that put ^NSEI 24245.699 into paper_performance when the settled
 * NIFTY 50 close was 24154.9 — 0.375% wrong, and invisible to any single-source
 * check because the exact-session rule validates the DATE, not the VALUE.
 *
 * Fail-closed is affordable because agreement is the norm: measured 2026-08-18,
 * Massive /prev and Yahoo matched to the cent on every US holding
 * (MSFT 481.63/481.63, NVDA 219.74/219.74, XAR 290.43/290.43).
 */
const base = {
  positionId: "p1", symbol: "MSFT", market: "us" as const,
  qty: 2, avgCost: 400,
  persistedPrice: 470, persistedAt: "2026-08-17T20:15:00Z",
  liveSource: "massive", liveObservedAt: "2026-08-18T20:00:00Z",
};
const NOW = new Date("2026-08-18T20:15:00Z");

describe("position marks are corroborated by an independent vendor", () => {
  it("accepts a corroborated quote and says so", () => {
    const m = buildPositionMark({ ...base, livePrice: 481.63, crossPrice: 481.63, crossSource: "yahoo_us" }, NOW);
    expect(m.provenance).toBe("live_quote");
    expect(m.stale).toBe(false);
    expect(m.mark).toBe(481.63);
    expect(m.reason).toContain("corroborated by yahoo_us");
  });

  it("REFUSES a GROSSLY disputed quote — it must not price a stop or target", () => {
    // 9.36%: the real KGC stale-Alpha-Vantage case. No vendor difference
    // explains a gap that size.
    const m = buildPositionMark({ ...base, livePrice: 526.7, crossPrice: 481.63, crossSource: "yahoo_us" }, NOW);
    expect(m.provenance).toBe("carry_forward");
    expect(m.stale).toBe(true);
    expect(m.mark).toBe(470);            // the carried mark, NOT the disputed price
    expect(m.reason).toContain("DISPUTED");
    expect(m.reason).toContain("526.7");   // both numbers preserved for audit
    expect(m.reason).toContain("481.63");
  });

  // 2026-08-20 regression: a single 0.1% gate refused all 13 India holdings and
  // left the book unmonitored. `fetchIndiaQuotes` returns a last-traded QUOTE
  // while `fetchUpstoxCandles` returns the settled daily CLOSE — different
  // measurements, so sub-1% gaps are expected and must not stop monitoring.
  it("USES a mildly divergent quote and records the gap — the India regression", () => {
    // HINDALCO: yahoo_india 1029.85 vs upstox 1038.95 = 0.876%.
    const m = buildPositionMark(
      { ...base, symbol: "HINDALCO.NS", livePrice: 1029.85, crossPrice: 1038.95, crossSource: "upstox" }, NOW);
    expect(m.provenance).toBe("live_quote");   // NOT refused
    expect(m.stale).toBe(false);
    expect(m.mark).toBe(1029.85);
    expect(m.reason).toContain("0.876%");
    expect(m.reason).toContain("upstox");
    expect(m.reason).not.toContain("DISPUTED");
  });

  it("the two thresholds are ordered and both do real work", () => {
    expect(MARK_DISPUTE_REFUSE_PCT).toBeGreaterThan(MARK_CROSSCHECK_TOLERANCE_PCT);
    // The AV wrong-session error on NVDA was 1.002% — BELOW India's legitimate
    // 0.876% neighbourhood. Magnitude alone cannot separate them, which is why
    // the refuse gate sits well above both and catches only gross errors.
    expect(MARK_DISPUTE_REFUSE_PCT).toBeGreaterThan(1.002);
  });

  it("treats rounding-scale agreement as corroboration", () => {
    const within = 481.63 * (1 + (MARK_CROSSCHECK_TOLERANCE_PCT / 100) * 0.5);
    const m = buildPositionMark({ ...base, livePrice: within, crossPrice: 481.63, crossSource: "yahoo_us" }, NOW);
    expect(m.provenance).toBe("live_quote");
  });

  it("marks an uncorroborated quote as such rather than pretending it was checked", () => {
    const m = buildPositionMark({ ...base, livePrice: 481.63, crossPrice: null, crossSource: null }, NOW);
    expect(m.provenance).toBe("live_quote");
    expect(m.reason).toContain("uncorroborated");
  });

  it("a cross-source outage cannot demote a good mark", () => {
    // No cross price at all must behave exactly as before this feature existed.
    const withOutage = buildPositionMark({ ...base, livePrice: 481.63 }, NOW);
    expect(withOutage.provenance).toBe("live_quote");
    expect(withOutage.mark).toBe(481.63);
  });

  it("a grossly disputed quote with NO carried mark falls to entry cost, never to the disputed price", () => {
    const m = buildPositionMark(
      { ...base, persistedPrice: null, persistedAt: null, livePrice: 999, crossPrice: 481.63, crossSource: "yahoo_us" },
      NOW,
    );
    expect(m.provenance).toBe("entry_cost");
    expect(m.mark).toBe(400);
    expect(m.stale).toBe(true);
  });

  it("a zero or negative cross price is ignored, not treated as disagreement", () => {
    const m = buildPositionMark({ ...base, livePrice: 481.63, crossPrice: 0, crossSource: "yahoo_us" }, NOW);
    expect(m.provenance).toBe("live_quote");
  });
});

/**
 * 2026-08-20: Yahoo became the PRIMARY for US settled marks (grouped publishes
 * next-day; the old chain resolved from Alpha Vantage, which serves the previous
 * session). A vendor may never corroborate itself — that circularity is exactly
 * what let the ^NSEI provisional value pass as "verified".
 */
describe("a vendor may not corroborate itself", () => {
  const src = (s: string) => ({ ...base, liveSource: s, livePrice: 481.63 });

  it("marks a Yahoo-primary quote uncorroborated when no other vendor supplied one", () => {
    const m = buildPositionMark({ ...src("yahoo"), crossPrice: null, crossSource: null }, NOW);
    expect(m.provenance).toBe("live_quote");
    expect(m.reason).toContain("uncorroborated");
  });

  it("route filter excludes yahoo-sourced primaries from the yahoo cross-check", () => {
    const route = require("node:fs").readFileSync("app/api/agents/position-monitor/route.ts", "utf8");
    expect(route).toMatch(/toLowerCase\(\)\.startsWith\("yahoo"\)/);
    expect(route).not.toContain('quoteMeta[s]?.source !== "yahoo_us"');
  });
});
