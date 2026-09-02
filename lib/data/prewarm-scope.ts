/**
 * Which symbols the price prewarm must keep fresh.
 *
 * THE DEFECT THIS FIXES. The freshness MONITOR and the price REFRESHER disagreed
 * about scope. `price-cache-us-symbols` requires freshness for
 * `active_us_price_symbols` — every US symbol scored in the last 7 days, plus
 * every open position (lib/monitoring/freshness-contracts.ts). But the research
 * cron prewarmed only TODAY'S batch plus the benchmark ETFs. A symbol scored
 * five days ago and not in today's batch was therefore required to be fresh and
 * refreshed by nothing.
 *
 * That is not a monitoring nit. A stale non-held symbol still gets scored,
 * still becomes entry-eligible, and is then refused at fill time by the quote
 * gate: measured 2026-09-01, `quote_stale=7` blocked 7 of 10 eligible US
 * candidates, and the monitor reported 17/113 scopes past grace at 85% coverage
 * against a 90% floor.
 *
 * ORDER IS THE BUDGET POLICY. prewarmPriceCache is deadline-bounded and works
 * through its input in order, so whatever cannot fit today must be the least
 * costly to leave stale. Open positions come first (their marks drive stops,
 * targets and NAV), then today's candidates (they can fill today), then
 * benchmarks (comparison series), then the recent-decision tail (cannot move
 * money today, but will be re-scored soon). Widening the list is close to free:
 * the prewarm resolves freshness for the whole set in ONE bulk query and only
 * fetches what is actually stale.
 */

export interface PrewarmScopeSources {
  /** Symbols scored in this run — they can fill today. */
  batch: string[];
  /** Benchmark/comparison symbols. */
  benchmarks: string[];
  /** Currently open positions in this market. */
  openPositions: string[];
  /** Symbols scored recently enough that the freshness contract still demands them. */
  recentlyScored: string[];
}

/**
 * De-duplicated, priority-ordered prewarm list.
 *
 * Priority is by MONEY CONSEQUENCE of staleness, not by recency or convenience.
 */
export function resolvePrewarmScope(sources: PrewarmScopeSources): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (symbols: string[]) => {
    for (const raw of symbols) {
      const symbol = String(raw ?? "").trim().toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      out.push(symbol);
    }
  };
  // Order is load-bearing — see the module comment.
  push(sources.openPositions);
  push(sources.batch);
  push(sources.benchmarks);
  push(sources.recentlyScored);
  return out;
}

/**
 * How far back the freshness contract considers a scored symbol "active".
 * MUST match `active_us_price_symbols` in lib/monitoring/freshness-contracts.ts:
 * if the refresher looks back less far than the monitor demands, the gap
 * reopens silently.
 */
export const PREWARM_RECENT_DECISION_DAYS = 7;
