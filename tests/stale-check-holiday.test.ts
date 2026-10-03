import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expectedJobMarket, isExpectedMarketHoliday } from "@/lib/monitoring/market-holiday";

describe("stale-check market holidays", () => {
  const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

  it("classifies market-specific vs market-agnostic jobs", () => {
    expect(expectedJobMarket({ label: "Research (India)", requiresIndia: true })).toBe("india");
    expect(expectedJobMarket({ label: "PositionMonitor (US)" })).toBe("us");
    expect(expectedJobMarket({ label: "Label maturation" })).toBeNull();
    expect(expectedJobMarket({ label: "LearnerAgent (US weekly)" })).toBe("us");
  });
  it("suppresses India jobs on the 2026-10-02 NSE holiday (the false 'Research (India) missed' alert)", () => {
    expect(isExpectedMarketHoliday({ label: "Research (India)", requiresIndia: true }, day("2026-10-02"))).toBe(true);
  });
  it("does not suppress US jobs on an India holiday, or any job on a normal trading day", () => {
    expect(isExpectedMarketHoliday({ label: "Research (US)" }, day("2026-10-02"))).toBe(false);
    expect(isExpectedMarketHoliday({ label: "Research (India)", requiresIndia: true }, day("2026-10-01"))).toBe(false);
  });
  it("never suppresses a market-agnostic job", () => {
    expect(isExpectedMarketHoliday({ label: "Label maturation" }, day("2026-10-02"))).toBe(false);
  });
  it("the route applies the holiday skip before querying runs", () => {
    const src = readFileSync("app/api/alerts/stale-check/route.ts", "utf8");
    expect(src.indexOf("isExpectedMarketHoliday(job, expectedDayStart)")).toBeGreaterThan(0);
    expect(src.indexOf("isExpectedMarketHoliday(job, expectedDayStart)")).toBeLessThan(src.indexOf("const { data: todaysRuns }"));
  });
});
