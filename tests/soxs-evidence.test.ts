import { describe, expect, it } from "vitest";
import { soxsEntryWindow, soxsQuoteTime } from "@/lib/trading/soxs-evidence";
import type { DeterministicQuote } from "@/lib/data/quotes";

const now = Date.parse("2026-09-22T16:05:00Z");
const quote: DeterministicQuote = { symbol: "SOXS", price: 50, bid: 49.99, ask: 50.01,
  change: null, changePct: null, source: "massive", stale: false,
  retrievedAt: new Date(now).toISOString(), observedAt: new Date(now - 1000).toISOString() };
describe("SOXS route evidence", () => {
  it("does not replace absent provider time with fetch time", () => {
    expect(soxsQuoteTime({ ...quote, observedAt: undefined }, now)).toBeNaN();
    expect(soxsQuoteTime(quote, now)).toBe(now - 1000);
  });
  it("rejects stale, future and explicitly stale quotes", () => {
    for (const observedAt of [new Date(now + 1).toISOString(), new Date(now - 16 * 60000).toISOString()])
      expect(soxsQuoteTime({ ...quote, observedAt }, now)).toBeNaN();
    expect(soxsQuoteTime({ ...quote, stale: true }, now)).toBeNaN();
  });
  it("enforces the 12:00-12:14 ET window, offset from SOXL/TQQQ/SQQQ", () => {
    expect(soxsEntryWindow(new Date(now))).toBe(true); // 16:05 UTC = 12:05 EDT
    expect(soxsEntryWindow(new Date("2026-12-01T17:05:00Z"))).toBe(true); // 12:05 EST
    expect(soxsEntryWindow(new Date("2026-09-22T15:45:00Z"))).toBe(false); // SQQQ's window, not SOXS's
    expect(soxsEntryWindow(new Date("2026-09-22T16:15:00Z"))).toBe(false); // past the window
  });
  it("rejects holidays, weekends and unsupported calendar years", () => {
    for (const date of ["2026-09-07T16:05:00Z", "2026-09-19T16:05:00Z", "2027-09-22T16:05:00Z"])
      expect(soxsEntryWindow(new Date(date))).toBe(false);
  });
});
