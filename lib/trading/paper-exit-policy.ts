import { isMarketHoliday } from "@/lib/trading/market-calendar";

/**
 * Score below which a held position is exited: the ENTRY THRESHOLD itself.
 *
 * The rule is "would this be bought today?". If the fresh score no longer clears
 * the bar that admitted it, the research no longer supports holding it, so it is
 * closed. That is the ONLY score condition, and with the time stop removed
 * (2026-09-10, superseding Decision 65) it is the primary non-price exit.
 *
 * THE DEFECT THIS FIXES. This returned `max(35, entry - hysteresis)` — with the
 * live entry threshold of 60 and the profile's hysteresis of 15, a position had
 * to collapse from 60+ to below 45 before the score could close it. Measured
 * over 203 closed paper lots: the score exit fired ZERO times, while the time
 * stop fired 140. A 15-point dead band meant the clock, not the research, was
 * the real exit policy.
 *
 * Measured on the 140 time-stopped lots, using the scores actually observed
 * while each was held, the minimum score reached was below 60 for 29/62 US
 * (47%) and 12/78 India (15%) — so this band produces a real exit rather than an
 * inert one, and the India figure being low is the correct result: those
 * holdings kept scoring well (mean minimum 73) and the clock was cutting winners
 * short.
 *
 * `hysteresis` is accepted for call-compatibility and deliberately ignored: any
 * non-zero band reintroduces the dead zone this fixes. Churn is bounded instead
 * by the score-freshness gate (`max_signal_age_sessions`) — a stale score can
 * never exit a position.
 */
export function resolvePaperExitThreshold(entryThreshold: number, _hysteresis?: number): number {
  return Number.isFinite(entryThreshold) ? entryThreshold : 60;
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
