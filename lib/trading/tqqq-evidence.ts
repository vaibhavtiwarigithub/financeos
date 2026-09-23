import type { DeterministicQuote } from "@/lib/data/quotes";
import { getMarketDayStatus, isMarketSessionOpen } from "./market-calendar";

/** Provider observation time, never the HTTP fetch time. Mirrors soxl-evidence.ts. */
export function tqqqQuoteTime(quote: DeterministicQuote, now: number): number {
  const time = Date.parse(quote.observedAt ?? "");
  return !quote.stale && quote.source !== "unavailable" && Number.isFinite(time)
    && time <= now && now - time <= 15 * 60_000 ? time : NaN;
}

/** 11:20-11:34 ET — 15 min after SOXL's 11:00-11:14 window so the two dedicated
 * doors never contend for the same cron minute (the shared paper_portfolio
 * row lock in each RPC would serialize them safely either way; this just
 * avoids the race entirely). */
export function tqqqEntryWindow(now: Date): boolean {
  if (getMarketDayStatus("us", now).kind !== "trading_day" || !isMarketSessionOpen("us", now)) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const minute = Number(parts.find(p => p.type === "minute")?.value);
  return hour === 11 && minute >= 20 && minute < 35;
}
