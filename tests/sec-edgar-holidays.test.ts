import { describe, expect, it } from "vitest";
import { federalHolidaysObserved, isFilingDay, isSecHoliday, publishedEdgarIndexDates } from "@/lib/listings/sec-edgar";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("SEC EDGAR federal-holiday calendar", () => {
  it("flags Columbus Day 2026-10-12, the day production raised a false 403 'sources incomplete' warning", () => {
    expect(isSecHoliday(d("2026-10-12"))).toBe(true);
    expect(isFilingDay(d("2026-10-12"))).toBe(false);
    expect(isFilingDay(d("2026-10-13"))).toBe(true);
  });
  it("computes the 2026 observed holiday set", () => {
    expect([...federalHolidaysObserved(2026)].sort()).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
    ]); // July 4 2026 is a Saturday -> observed Friday July 3
  });
  it("observes a Sunday holiday on Monday and a Saturday New Year on Dec 31", () => {
    expect(federalHolidaysObserved(2027).has("2027-06-18")).toBe(true); // Juneteenth 2027 is a Saturday -> Friday
    expect(isSecHoliday(d("2027-12-31"))).toBe(true); // Jan 1 2028 is a Saturday -> observed Dec 31 2027
    expect(isSecHoliday(d("2027-07-05"))).toBe(true); // July 4 2027 is a Sunday -> Monday
  });
  it("skips the holiday when choosing which published index dates to fetch", () => {
    // 2026-10-13 08:35 UTC is before 03:00 ET? No: 04:35 ET, so the newest candidate is the previous ET date, 10-12 (holiday) -> skipped.
    const dates = publishedEdgarIndexDates(new Date("2026-10-13T08:35:00Z")).map((x) => x.toISOString().slice(0, 10));
    expect(dates).not.toContain("2026-10-12");
    expect(dates).toEqual(["2026-10-09", "2026-10-08", "2026-10-07"]);
  });
});
