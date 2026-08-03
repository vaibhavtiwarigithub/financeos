import { describe, expect, it } from "vitest";
import { isRealIsoDate, normalizeRealIsoDate } from "@/lib/date-only";
import { daysFromToday } from "@/lib/data/earnings";

describe("real ISO calendar dates", () => {
  it("accepts real leap days and rejects overflow dates", () => {
    expect(isRealIsoDate("2024-02-29")).toBe(true);
    expect(isRealIsoDate("2026-02-29")).toBe(false);
    expect(isRealIsoDate("2026-02-31")).toBe(false);
    expect(normalizeRealIsoDate("2026-07-31T12:30:00Z")).toBe("2026-07-31");
  });

  it("does not convert an impossible provider date into a different event day", () => {
    expect(daysFromToday("2026-02-31")).toBeNull();
  });

  // This is the ONE parser every earnings collector routes through
  // (earnings_calendar cache, Finnhub/Yahoo base, Webull, Robinhood, India
  // Yahoo). Each rejection below must stay a null, never a coerced date, or the
  // fail-closed conflict path in tradingSessionsBetween reopens.
  it.each([
    ["valid ISO day", "2026-07-31", "2026-07-31"],
    ["ISO datetime", "2026-07-31T12:30:00Z", "2026-07-31"],
    ["surrounding whitespace", "  2026-07-31 ", "2026-07-31"],
    ["impossible day", "2026-02-30", null],
    ["wrong format", "31/07/2026", null],
    ["compact date, not an epoch", "20260731", null],
    ["empty string", "", null],
    ["null", null, null],
    ["undefined", undefined, null],
    ["NaN", Number.NaN, null],
    ["object", { date: "2026-07-31" }, null],
    // Yahoo India sends the earnings date as epoch seconds.
    ["epoch seconds", 1785153600, "2026-07-27"],
    ["epoch seconds as a string", "1785153600", "2026-07-27"],
    ["epoch milliseconds", 1785153600000, "2026-07-27"],
    ["negative epoch", -1785153600, null],
    ["out-of-range epoch", 1e18, null],
  ])("normalizes %s", (_name, input, expected) => {
    expect(normalizeRealIsoDate(input)).toBe(expected);
  });
});
