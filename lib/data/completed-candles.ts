import type { Candle } from "@/lib/data/technicals";
import { isMarketHoliday, lastCompletedMarketSession } from "@/lib/trading/market-calendar";
import { assertNotCryptoFamily } from "@/lib/data/crypto-session";
import type { InstrumentFamily } from "@/lib/scoring/instrument-taxonomy";

type Market = "us" | "india";

const SESSION: Record<Market, { timeZone: string; closeMinutes: number }> = {
  us: { timeZone: "America/New_York", closeMinutes: 16 * 60 },
  india: { timeZone: "Asia/Kolkata", closeMinutes: 15 * 60 + 30 },
};

function localClock(market: Market, now: Date): { ymd: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SESSION[market].timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number.parseInt(get("hour"), 10) % 24;
  const minute = Number.parseInt(get("minute"), 10);
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + minute,
  };
}

function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Daily scoring may only consume settled regular-session bars. Provider adapters
 * remain free to return an intraday daily bar for chart/quote consumers.
 *
 * `instrumentFamily` is optional. When provided, throws if family="crypto" —
 * crypto instruments must use cryptoCompletedCandles() from lib/data/crypto-session.ts.
 */
export function completedSessionCandles<T extends Candle>(
  candles: readonly T[],
  market: Market,
  now: Date = new Date(),
  instrumentFamily?: InstrumentFamily,
): T[] {
  assertNotCryptoFamily(instrumentFamily, "completedSessionCandles");
  const local = localClock(market, now);
  const todayComplete = local.minutes >= SESSION[market].closeMinutes;
  return candles.filter((candle) => {
    if (!isValidYmd(candle.date)) return false;
    if (candle.date < local.ymd) return true;
    return candle.date === local.ymd && todayComplete;
  });
}

/**
 * The newest session that SHOULD have a settled bar as of `now`.
 *
 * Distinct from `lastCompletedMarketSession`, which always steps back at least
 * one calendar day and therefore still names Friday at 16:15 ET on Monday. That
 * leniency is correct for an EOD cache read during a running session (today's
 * bar may legitimately not exist yet) but wrong once today's session has closed:
 * on 2026-08-17 it let Friday's close be marked, stop-checked and target-checked
 * as Monday's price for all 13 US positions.
 *
 * After the close on a trading day the answer is TODAY. Before the close, on a
 * weekend, or on a holiday it falls back to the previous completed session.
 *
 * Callers compare with `>=` so a provisional bar for the running session still
 * passes — this tightens the post-close case only.
 */
/**
 * `instrumentFamily` is optional. When provided, throws if family="crypto".
 */
export function expectedNewestSession(market: Market, now: Date = new Date(), instrumentFamily?: InstrumentFamily): string {
  assertNotCryptoFamily(instrumentFamily, "expectedNewestSession");
  const local = localClock(market, now);
  const dow = new Date(`${local.ymd}T12:00:00Z`).getUTCDay();
  const todayIsTradingDay = dow !== 0 && dow !== 6 && !isMarketHoliday(market, local.ymd);
  if (todayIsTradingDay && local.minutes >= SESSION[market].closeMinutes) return local.ymd;
  return lastCompletedMarketSession(market, now);
}
