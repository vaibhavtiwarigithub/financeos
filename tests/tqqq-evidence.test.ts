import { describe, expect, it } from "vitest";
import { tqqqEntryWindow, tqqqQuoteTime } from "@/lib/trading/tqqq-evidence";
import type { DeterministicQuote } from "@/lib/data/quotes";

const now = Date.parse("2026-09-22T15:25:00Z");
const quote: DeterministicQuote = { symbol: "TQQQ", price: 50, bid: 49.99, ask: 50.01,
  change: null, changePct: null, source: "massive", stale: false,
  retrievedAt: new Date(now).toISOString(), observedAt: new Date(now - 1000).toISOString() };
describe("TQQQ route evidence", () => {
  it("does not replace absent provider time with fetch time", () => {
    expect(tqqqQuoteTime({ ...quote, observedAt: undefined }, now)).toBeNaN();
    expect(tqqqQuoteTime(quote, now)).toBe(now - 1000);
  });
  it("rejects stale, future and explicitly stale quotes", () => {
    for (const observedAt of [new Date(now + 1).toISOString(), new Date(now - 16 * 60000).toISOString()])
      expect(tqqqQuoteTime({ ...quote, observedAt }, now)).toBeNaN();
    expect(tqqqQuoteTime({ ...quote, stale: true }, now)).toBeNaN();
  });
  it("enforces the 11:20-11:34 ET window in summer and winter, offset from SOXL's 11:00-11:14", () => {
    expect(tqqqEntryWindow(new Date(now))).toBe(true); // 15:25 UTC = 11:25 EDT
    expect(tqqqEntryWindow(new Date("2026-12-01T16:25:00Z"))).toBe(true); // 11:25 EST
    expect(tqqqEntryWindow(new Date("2026-09-22T15:05:00Z"))).toBe(false); // 11:05 EDT — SOXL's window, not TQQQ's
    expect(tqqqEntryWindow(new Date("2026-09-22T15:35:00Z"))).toBe(false); // 11:35 EDT — past the window
  });
  it("rejects holidays, weekends and unsupported calendar years", () => {
    for (const date of ["2026-09-07T15:25:00Z", "2026-09-19T15:25:00Z", "2027-09-22T15:25:00Z"])
      expect(tqqqEntryWindow(new Date(date))).toBe(false);
  });
});
