import type { DeterministicQuote } from "@/lib/data/quotes";
import { getMarketDayStatus, isMarketSessionOpen } from "./market-calendar";

/** Provider observation time, never the HTTP fetch time. */
export function soxlQuoteTime(quote: DeterministicQuote, now: number): number {
  const time = Date.parse(quote.observedAt ?? "");
  return !quote.stale && quote.source !== "unavailable" && Number.isFinite(time)
    && time <= now && now - time <= 15 * 60_000 ? time : NaN;
}

export function soxlEntryWindow(now: Date): boolean {
  if (getMarketDayStatus("us", now).kind !== "trading_day" || !isMarketSessionOpen("us", now)) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const minute = Number(parts.find(p => p.type === "minute")?.value);
  return hour === 11 && minute < 15;
}
