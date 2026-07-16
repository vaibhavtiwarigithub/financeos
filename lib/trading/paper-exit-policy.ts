import { isMarketHoliday } from "@/lib/trading/market-calendar";

export function resolvePaperExitThreshold(entryThreshold: number, hysteresis: number): number {
  const entry = Number.isFinite(entryThreshold) ? entryThreshold : 60;
  const gap = Number.isFinite(hysteresis) && hysteresis > 0 ? hysteresis : 15;
  return Math.max(35, entry - gap);
}

function marketDate(date: Date, market: "us" | "india"): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = get("year"), month = get("month"), day = get("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function marketSessionsSince(createdAt: string, now: Date, market: "us" | "india"): number {
  const startYmd = marketDate(new Date(createdAt), market);
  const endYmd = marketDate(now, market);
  if (!startYmd || !endYmd || endYmd < startYmd) return Number.POSITIVE_INFINITY;
  const cursor = new Date(`${startYmd}T00:00:00Z`);
  const end = new Date(`${endYmd}T00:00:00Z`);
  let sessions = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const ymd = cursor.toISOString().slice(0, 10);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6 && !isMarketHoliday(market, ymd)) sessions++;
  }
  return sessions;
}

export function isPaperScoreFresh(createdAt: string | null | undefined, now: Date, market: "us" | "india", maxSessions: number): boolean {
  if (!createdAt || !Number.isInteger(maxSessions) || maxSessions < 0) return false;
  return marketSessionsSince(createdAt, now, market) <= maxSessions;
}

export function paperPositionOpenedAt(position: { opened_at?: string | null; created_at?: string | null }): string | null {
  return position.opened_at ?? position.created_at ?? null;
}
