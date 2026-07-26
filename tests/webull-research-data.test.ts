import { afterEach, describe, expect, it, vi } from "vitest";
import { daysFromToday } from "@/lib/data/earnings";
import { parseCapitalFlow } from "@/lib/data/webull-data";

describe("Webull research evidence", () => {
  afterEach(() => vi.useRealTimers());

  it("does not fabricate capital flow when a required leg is absent", () => {
    expect(parseCapitalFlow([{ date: "2026-07-24", large_in: 10, large_out: null, medium_in: 2, medium_out: 1, small_in: 2, small_out: 1 }])).toBeNull();
  });

  it("uses at most the reported five completed capital-flow days", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      date: `2026-07-${String(24 - i).padStart(2, "0")}`,
      large_in: 10, large_out: 4, medium_in: 2, medium_out: 1, small_in: 3, small_out: 2,
    }));
    expect(parseCapitalFlow(rows)).toMatchObject({ largNet5d: 30, signal: "bullish" });
  });

  it("accepts date-only, ISO, epoch, and US-formatted earnings dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T16:00:00Z"));
    for (const date of ["2026-07-27", "2026-07-27T14:00:00Z", 1785153600, 1785153600000, "07/27/2026"]) {
      expect(daysFromToday(date, false)).toBe(3);
    }
  });
});
