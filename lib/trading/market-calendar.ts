// Exchange holiday calendars. A holiday falling on a weekday would otherwise
// pass the weekday+hours session check and let a market order be attempted while
// the exchange is closed. MUST be updated annually (or replaced with a calendar
// API / broker market-status endpoint). Dates are the market-local YYYY-MM-DD.
//
// NYSE full-day closures 2026 (well-defined federal/market holidays):
const US_HOLIDAYS = new Set<string>([
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
]);

// NSE full-day trading holidays 2026 (approximate — VERIFY against the official
// NSE circular; the list shifts with lunar dates each year). When in doubt the
// broker rejects an out-of-session order anyway; this is the defensive layer.
const INDIA_HOLIDAYS = new Set<string>([
  "2026-01-26", // Republic Day
  "2026-03-06", // Holi
  "2026-03-25", // Ram Navami
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-08-15", // Independence Day
  "2026-10-02", // Gandhi Jayanti
  "2026-11-09", // Diwali (approx)
  "2026-12-25", // Christmas
]);

export function isMarketHoliday(market: string, localYmd: string): boolean {
  return (market === "india" ? INDIA_HOLIDAYS : US_HOLIDAYS).has(localYmd);
}
