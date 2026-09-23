import { describe, expect, it } from "vitest";
import { sqqqEntryWindow, sqqqQuoteTime } from "@/lib/trading/sqqq-evidence";
import type { DeterministicQuote } from "@/lib/data/quotes";

const now = Date.parse("2026-09-22T15:45:00Z");
const quote: DeterministicQuote = { symbol: "SQQQ", price: 50, bid: 49.99, ask: 50.01,
  change: null, changePct: null, source: "massive", stale: false,
  retrievedAt: new Date(now).toISOString(), observedAt: new Date(now - 1000).toISOString() };
describe("SQQQ route evidence", () => {
  it("does not replace absent provider time with fetch time", () => {
    expect(sqqqQuoteTime({ ...quote, observedAt: undefined }, now)).toBeNaN();
    expect(sqqqQuoteTime(quote, now)).toBe(now - 1000);
  });
  it("rejects stale, future and explicitly stale quotes", () => {
    for (const observedAt of [new Date(now + 1).toISOString(), new Date(now - 16 * 60000).toISOString()])
      expect(sqqqQuoteTime({ ...quote, observedAt }, now)).toBeNaN();
    expect(sqqqQuoteTime({ ...quote, stale: true }, now)).toBeNaN();
  });
  it("enforces the 11:40-11:54 ET window, offset from SOXL/TQQQ", () => {
    expect(sqqqEntryWindow(new Date(now))).toBe(true); // 15:45 UTC = 11:45 EDT
    expect(sqqqEntryWindow(new Date("2026-12-01T16:45:00Z"))).toBe(true); // 11:45 EST
    expect(sqqqEntryWindow(new Date("2026-09-22T15:20:00Z"))).toBe(false); // TQQQ's window, not SQQQ's
    expect(sqqqEntryWindow(new Date("2026-09-22T15:55:00Z"))).toBe(false); // past the window
  });
  it("rejects holidays, weekends and unsupported calendar years", () => {
    for (const date of ["2026-09-07T15:45:00Z", "2026-09-19T15:45:00Z", "2027-09-22T15:45:00Z"])
      expect(sqqqEntryWindow(new Date(date))).toBe(false);
  });
});
