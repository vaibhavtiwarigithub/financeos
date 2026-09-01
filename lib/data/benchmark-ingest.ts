// Provider selection for SECONDARY benchmark price ingestion.
//
// Extracted from app/api/agents/benchmark-scorecard/route.ts so the rule below
// is unit-testable.
//
// THE RULE: pick the provider whose data reaches FURTHEST FORWARD, not the first
// one that returns anything.
//
// The bug this exists to prevent (fixed 2026-09-01): the route fell back only
// when the preferred provider returned NOTHING (`if (!candles.length)`). A
// provider returning 500 bars that all end eight days ago passes that check, so
// the benchmark went stale silently and indefinitely. Measured in production:
//
//   XLF  -> yahoo   (Massive empty, so it fell back)   current at 2026-08-31
//   XLK  -> massive (500 bars, none recent)            stale   at 2026-08-24
//   QQQ  -> massive                                    stale   at 2026-08-28
//
// The downstream cost was not cosmetic: the comparison chart truncated the
// PORTFOLIO series to the stale benchmark's coverage and reported +0.010%
// instead of +1.345% for an identical window.

export interface ProviderAttempt<C extends { date?: string | null }> {
  provider: string;
  candles: readonly C[];
}

/** Newest bar date (YYYY-MM-DD) in a candle series, or null when empty. */
export function newestBarDate<C extends { date?: string | null }>(
  candles: readonly C[],
): string | null {
  let newest: string | null = null;
  for (const c of candles) {
    const d = c?.date ? String(c.date).slice(0, 10) : null;
    if (d && (newest == null || d > newest)) newest = d;
  }
  return newest;
}

/**
 * Choose the attempt reaching furthest forward.
 *
 * Empty attempts are ignored. Ties keep the EARLIER attempt, so the caller's
 * preferred provider wins when both are equally current — order the array by
 * preference. Returns null when every attempt is empty.
 *
 * Deliberately compares recency, NOT series length: the staler series in the
 * production case was also the longest one.
 */
export function pickFreshestProvider<C extends { date?: string | null }>(
  attempts: readonly ProviderAttempt<C>[],
): ProviderAttempt<C> | null {
  const usable = attempts.filter((a) => a.candles.length > 0);
  if (!usable.length) return null;
  return usable.reduce((a, b) => {
    const an = newestBarDate(a.candles);
    const bn = newestBarDate(b.candles);
    if (an == null) return b;
    if (bn == null) return a;
    return bn > an ? b : a;
  });
}
