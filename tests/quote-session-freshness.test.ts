import { describe, it, expect } from "vitest";
import { expectedNewestSession } from "@/lib/data/completed-candles";

/** The adapter's rule: a bar is fresh iff it is at least the session that should exist by now. */
const isFresh = (date: string, market: "us" | "india", now: Date) => date >= expectedNewestSession(market, now);

/**
 * 2026-08-17 incident. At 16:15 ET on Monday 2026-08-17 the PositionMonitor
 * marked, stop-checked and target-checked all 13 US positions against Friday
 * 2026-08-14's close, which the quote adapter returned as `stale: false`.
 *
 * Cause: `isStale()` asked "is this less than 4 CALENDAR days old" instead of
 * "is this the last completed session". Friday's bar is 3.01 days old on Monday
 * afternoon, so it passed. `paper_position_marks` recorded the contradiction
 * faithfully — provenance `live_quote`, stale false, age_days 3.01 — which is
 * how the defect was found.
 *
 * These pin the session rule the adapter now uses.
 */
describe("cached-bar freshness follows the SESSION, not a calendar-day window", () => {
  // Monday 2026-08-17, 16:15 ET == 20:15 UTC. Monday's session has completed.
  const MON_AFTER_CLOSE = new Date("2026-08-17T20:15:00Z");

  it("REJECTS Friday's bar on Monday after the close — the exact production defect", () => {
    // 3.01 calendar days old: the old 4-day window accepted this.
    expect(isFresh("2026-08-14", "us", MON_AFTER_CLOSE)).toBe(false);
  });

  it("accepts Monday's own bar once Monday's session is complete", () => {
    expect(isFresh("2026-08-17", "us", MON_AFTER_CLOSE)).toBe(true);
  });

  it("accepts Friday's bar over the weekend — then it IS the last completed session", () => {
    const SAT = new Date("2026-08-15T18:00:00Z");
    const SUN = new Date("2026-08-16T18:00:00Z");
    expect(isFresh("2026-08-14", "us", SAT)).toBe(true);
    expect(isFresh("2026-08-14", "us", SUN)).toBe(true);
  });

  it("a bar older than one session is refused regardless of how few days elapsed", () => {
    // Tuesday after close: Monday's bar is only ~1 day old but is not the newest
    // completed session, so it must not be presented as current.
    const TUE_AFTER_CLOSE = new Date("2026-08-18T20:15:00Z");
    expect(isFresh("2026-08-17", "us", TUE_AFTER_CLOSE)).toBe(false);
    expect(isFresh("2026-08-18", "us", TUE_AFTER_CLOSE)).toBe(true);
  });
});
