import { getMarketDayStatus } from "@/lib/trading/market-calendar";

/** Market a market-specific job belongs to; null for market-agnostic jobs (label maturation, scorecards, ...). */
export function expectedJobMarket(job: { label: string; requiresIndia?: boolean }): "us" | "india" | null {
  if (job.requiresIndia || /\(India\)/.test(job.label)) return "india";
  if (/\(US[) ]/.test(job.label)) return "us";
  return null;
}

/**
 * A market-specific job is not expected on that market's exchange holiday. The weekday-only check
 * raised "Research (India) missed" on 2026-10-02 (Gandhi Jayanti, NSE closed). Only a calendar-confirmed
 * holiday suppresses the alert; an unsupported year or any doubt still alerts.
 */
export function isExpectedMarketHoliday(job: { label: string; requiresIndia?: boolean }, expectedDay: Date): boolean {
  const market = expectedJobMarket(job);
  if (!market) return false;
  return getMarketDayStatus(market, new Date(expectedDay.getTime() + 12 * 3600_000)).kind === "holiday";
}
