// Resolve the two most recent trading sessions from cached daily bars.
//
// WHY THIS EXISTS. The Markets pages used to call the market-data provider on
// every request (behind short 5-minute caches). But the values they show are
// DAILY: `/api/markets/overview` renders close-vs-prior-close from grouped daily
// bars, and `/api/markets/quotes` rendered the provider's previous-day
// aggregate. Both change exactly once per session, so a five-minute refresh
// cycle meant up to ~288 refresh windows a day for values that move once.
//
// The daily pipeline already exists and is already paid for:
// `kairos-price-cache-fill` (13:25 UTC weekdays, retry 13:45) writes the whole
// universe into `price_cache` in ONE grouped provider call, and that universe
// covers every symbol these pages need. Reading it makes the pages pure DB
// reads: one provider call per day for the system, none per page view.
//
// Staleness is not silent. `price_cache` has a per-symbol high-watermark
// freshness contract in `lib/monitoring/freshness-contracts.ts`, checked by the
// 4-hourly `kairos-stale-check`, so a broken fill raises an alert rather than
// quietly freezing the tiles.

export interface CachedBar {
  symbol: string;
  date: string;
  close: number | null;
}

export interface CachedSession {
  date: string;
  closes: Map<string, number>;
}

/**
 * The latest session present in the cache, and the one before it.
 *
 * Sessions are resolved from the DATES PRESENT IN THE DATA, never from the
 * calendar: a holiday or an unfilled day simply is not there, so no weekend or
 * holiday logic is needed and a gap cannot silently shift a comparison onto the
 * wrong pair of sessions.
 *
 * Returns null when fewer than two distinct sessions carry a usable close —
 * the caller must degrade visibly rather than render a change against nothing.
 */
export function resolveCachedSessions(
  bars: readonly CachedBar[],
): { latest: CachedSession; prior: CachedSession } | null {
  const byDate = new Map<string, Map<string, number>>();
  for (const bar of bars) {
    if (bar.close == null || !Number.isFinite(Number(bar.close))) continue;
    const date = String(bar.date).slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, new Map());
    byDate.get(date)!.set(bar.symbol, Number(bar.close));
  }
  const dates = [...byDate.keys()].sort().reverse();
  if (dates.length < 2) return null;
  return {
    latest: { date: dates[0], closes: byDate.get(dates[0])! },
    prior: { date: dates[1], closes: byDate.get(dates[1])! },
  };
}

/** Per-symbol latest close and the prior one, for the simple quotes endpoint. */
export function resolveSymbolPair(
  bars: readonly CachedBar[],
): { close: number; date: string; priorClose: number | null } | null {
  const usable = bars
    .filter((b) => b.close != null && Number.isFinite(Number(b.close)))
    .map((b) => ({ date: String(b.date).slice(0, 10), close: Number(b.close) }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (!usable.length) return null;
  return {
    close: usable[0].close,
    date: usable[0].date,
    priorClose: usable[1]?.close ?? null,
  };
}
