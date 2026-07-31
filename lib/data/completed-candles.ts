import type { Candle } from "@/lib/data/technicals";

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
 */
export function completedSessionCandles<T extends Candle>(
  candles: readonly T[],
  market: Market,
  now: Date = new Date(),
): T[] {
  const local = localClock(market, now);
  const todayComplete = local.minutes >= SESSION[market].closeMinutes;
  return candles.filter((candle) => {
    if (!isValidYmd(candle.date)) return false;
    if (candle.date < local.ymd) return true;
    return candle.date === local.ymd && todayComplete;
  });
}
