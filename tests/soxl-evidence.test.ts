import { describe, expect, it } from "vitest";
import { soxlEntryWindow, soxlQuoteTime } from "@/lib/trading/soxl-evidence";
import type { DeterministicQuote } from "@/lib/data/quotes";

const now = Date.parse("2026-09-22T15:05:00Z");
const quote: DeterministicQuote = { symbol: "SOXL", price: 50, bid: 49.99, ask: 50.01,
  change: null, changePct: null, source: "massive", stale: false,
  retrievedAt: new Date(now).toISOString(), observedAt: new Date(now - 1000).toISOString() };
describe("SOXL route evidence", () => {
  it("does not replace absent provider time with fetch time", () => {
    expect(soxlQuoteTime({ ...quote, observedAt: undefined }, now)).toBeNaN();
    expect(soxlQuoteTime(quote, now)).toBe(now - 1000);
  });
  it("rejects stale, future and explicitly stale quotes", () => {
    for (const observedAt of [new Date(now + 1).toISOString(), new Date(now - 16 * 60000).toISOString()])
      expect(soxlQuoteTime({ ...quote, observedAt }, now)).toBeNaN();
    expect(soxlQuoteTime({ ...quote, stale: true }, now)).toBeNaN();
  });
  it("enforces ET windows in summer and winter", () => {
    expect(soxlEntryWindow(new Date(now))).toBe(true);
    expect(soxlEntryWindow(new Date("2026-12-01T16:05:00Z"))).toBe(true);
    expect(soxlEntryWindow(new Date("2026-09-22T15:15:00Z"))).toBe(false);
  });
  it("rejects holidays, weekends and unsupported calendar years", () => {
    for (const date of ["2026-09-07T15:05:00Z", "2026-09-19T15:05:00Z", "2027-09-22T15:05:00Z"])
      expect(soxlEntryWindow(new Date(date))).toBe(false);
  });
});
