// Span-awareness for cached price history.
//
// WHY THIS EXISTS
// ---------------
// A cache guard of the shape `rows.length > 0 && isFresh(newest)` checks COUNT
// and RECENCY but never SPAN. A `days=180` request for a symbol holding 2 bars
// passes that guard and short-circuits the REST backfill, so a "6M" return ends
// up computed across ONE day and labelled as six months.
//
// This is not hypothetical: at the time of writing, price_cache holds exactly 2
// bars (2026-07-14 → 2026-07-15) for 29 symbols including QQQ, DIA, VIXY and
// every XLK..XLC sector ETF, while SPY holds 222.
//
// NOTE: this is a NEW shared helper. `/api/charts/sector-returns` and
// SectorBreadth.tsx have the same class of bug and are owned by another agent;
// they are deliberately untouched here but can adopt these helpers.

export interface DatedRow {
  date: string; // YYYY-MM-DD, ascending order expected
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Calendar days actually covered by `rows` (oldest → newest).
 * 0 for fewer than 2 rows: a single bar spans no window and cannot support a
 * return calculation at all.
 */
export function actualSpanDays(rows: DatedRow[]): number {
  if (!rows || rows.length < 2) return 0;
  const oldest = Date.parse(rows[0].date + "T00:00:00Z");
  const newest = Date.parse(rows[rows.length - 1].date + "T00:00:00Z");
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return 0;
  return Math.max(0, Math.round((newest - oldest) / MS_PER_DAY));
}

/**
 * Fraction of the requested window the rows must span for cached history to be
 * usable. Trading days are ~69% of calendar days; 0.6 leaves room for holidays
 * and for a window whose start lands on a weekend.
 */
export const SPAN_COVERAGE_RATIO = 0.6;

/**
 * Whether cached rows cover enough of the requested window to be served without
 * a backfill. Requires at least 2 bars — one bar can never express a return.
 */
export function spansRequestedWindow(rows: DatedRow[], days: number): boolean {
  if (!rows || rows.length < 2) return false;
  return actualSpanDays(rows) >= days * SPAN_COVERAGE_RATIO;
}

/**
 * Whether a rendered series is materially shorter than what was asked for, and
 * so must NOT be labelled with the requested period (e.g. "6M").
 */
export function isShortHistory(rows: DatedRow[], days: number): boolean {
  if (!rows || rows.length < 2) return true;
  return actualSpanDays(rows) < days * 0.5;
}
