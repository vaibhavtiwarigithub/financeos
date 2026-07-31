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
});
