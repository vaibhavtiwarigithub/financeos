import { describe, it, expect } from "vitest";
import { buildPositionMark, MARK_CROSSCHECK_TOLERANCE_PCT } from "@/lib/paper/marks";

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

  it("REFUSES a disputed quote — it must not price a stop or target", () => {
    // 0.375%: the real ^NSEI provisional-value error, well past tolerance.
    const m = buildPositionMark({ ...base, livePrice: 483.44, crossPrice: 481.63, crossSource: "yahoo_us" }, NOW);
    expect(m.provenance).toBe("carry_forward");
    expect(m.stale).toBe(true);
    expect(m.mark).toBe(470);            // the carried mark, NOT the disputed price
    expect(m.reason).toContain("DISPUTED");
    expect(m.reason).toContain("483.44");  // both numbers preserved for audit
    expect(m.reason).toContain("481.63");
  });

  it("tolerates vendor rounding without crying wolf", () => {
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

  it("a disputed quote with NO carried mark falls to entry cost, never to the disputed price", () => {
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
