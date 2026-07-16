import { describe, expect, it } from "vitest";
import { isStrictlyPreAnnouncementVintage } from "@/lib/data/earnings-pit";

describe("isStrictlyPreAnnouncementVintage", () => {
  it("accepts a snapshot from the prior US market date", () => {
    expect(isStrictlyPreAnnouncementVintage("2026-07-14T23:59:00-04:00", "2026-07-15")).toBe(true);
  });

  it("rejects snapshots on the report date even before the open", () => {
    expect(isStrictlyPreAnnouncementVintage("2026-07-15T07:00:00-04:00", "2026-07-15")).toBe(false);
  });

  it("uses the US market date across UTC midnight", () => {
    // 02:00 UTC is still 22:00 ET on the previous calendar date in July.
    expect(isStrictlyPreAnnouncementVintage("2026-07-15T02:00:00Z", "2026-07-15")).toBe(true);
  });

  it("rejects invalid timestamps and report dates", () => {
    expect(isStrictlyPreAnnouncementVintage("not-a-date", "2026-07-15")).toBe(false);
    expect(isStrictlyPreAnnouncementVintage("2026-07-14T20:00:00Z", "07/15/2026")).toBe(false);
  });
});
