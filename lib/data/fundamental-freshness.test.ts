import { describe, expect, it } from "vitest";
import {
  EVENT_FUNDAMENTAL_MAX_AGE_DAYS,
  DEFAULT_FUNDAMENTAL_MAX_AGE_DAYS,
  reportedFundamentalMaxAgeDays,
} from "@/lib/data/fundamental-freshness";

describe("event-aware fundamental freshness", () => {
  const asOf = new Date("2026-07-31T18:00:00Z");

  it.each(["2026-07-28", "2026-07-31", "2026-08-14"])(
    "uses one day inside the event window for %s",
    (reportDate) => {
      expect(reportedFundamentalMaxAgeDays([reportDate], asOf)).toBe(EVENT_FUNDAMENTAL_MAX_AGE_DAYS);
    },
  );

  it.each(["2026-07-27", "2026-08-15"])(
    "uses seven days outside the event window for %s",
    (reportDate) => {
      expect(reportedFundamentalMaxAgeDays([reportDate], asOf)).toBe(DEFAULT_FUNDAMENTAL_MAX_AGE_DAYS);
    },
  );

  it("fails conservatively to seven days for unknown or malformed dates", () => {
    expect(reportedFundamentalMaxAgeDays([], asOf)).toBe(7);
    expect(reportedFundamentalMaxAgeDays(["not-a-date"], asOf)).toBe(7);
  });
});
