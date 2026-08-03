import { afterEach, describe, expect, it, vi } from "vitest";
import { daysFromToday } from "@/lib/data/earnings";
import { parseCapitalFlow, parseEarningsCalendar } from "@/lib/data/webull-data";

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

  // The Webull collector used to accept String(expected_publish_date) as-is,
  // the only earnings collector with no date validation of its own. It now uses
  // the shared lib/date-only parser, so a malformed date fails closed to null
  // while the estimate fields on the same row survive.
  it("rejects a malformed Webull earnings date without discarding the estimates", () => {
    const row = (date: unknown) => [
      { fiscal_year: 2026, fiscal_period: 2, eps_actual: 1.4, eps_est: 1.2 },
      { fiscal_year: 2026, fiscal_period: 3, eps_actual: null, expected_publish_date: date, eps_est: 1.5 },
    ];
    expect(parseEarningsCalendar(row("2026-07-27"))).toMatchObject({ nextDate: "2026-07-27", nextEpsEst: 1.5 });
    expect(parseEarningsCalendar(row(1785153600))).toMatchObject({ nextDate: "2026-07-27" });
    for (const bad of ["2026-02-30", "not-a-date", "07/27/2026"]) {
      expect(parseEarningsCalendar(row(bad))).toMatchObject({ nextDate: null, lastEpsActual: 1.4, lastEpsBeat: true });
    }
  });

  it("accepts date-only, ISO, epoch, and US-formatted earnings dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T16:00:00Z"));
    for (const date of ["2026-07-27", "2026-07-27T14:00:00Z", 1785153600, 1785153600000, "07/27/2026"]) {
      expect(daysFromToday(date, false)).toBe(3);
    }
  });
});
