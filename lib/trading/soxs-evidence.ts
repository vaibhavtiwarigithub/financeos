import type { DeterministicQuote } from "@/lib/data/quotes";
import { getMarketDayStatus, isMarketSessionOpen } from "./market-calendar";

/** Provider observation time, never the HTTP fetch time. Mirrors soxl-evidence.ts. */
export function soxsQuoteTime(quote: DeterministicQuote, now: number): number {
  const time = Date.parse(quote.observedAt ?? "");
  return !quote.stale && quote.source !== "unavailable" && Number.isFinite(time)
    && time <= now && now - time <= 15 * 60_000 ? time : NaN;
}

/** 12:00-12:14 ET — continues the 15-minute offset pattern from SOXL (11:00),
 * TQQQ (11:20), SQQQ (11:40), so no two dedicated doors ever share a cron minute. */
export function soxsEntryWindow(now: Date): boolean {
  if (getMarketDayStatus("us", now).kind !== "trading_day" || !isMarketSessionOpen("us", now)) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const minute = Number(parts.find(p => p.type === "minute")?.value);
  return hour === 12 && minute >= 0 && minute < 15;
}
