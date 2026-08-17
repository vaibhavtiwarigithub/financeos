// W9 — the freshness rule for a `price_cache` BAR, in exactly one place.
//
// W1 closed the fill and live-order boundaries (lib/data/quote-freshness.ts).
// It could only do so for callers that go through `getQuote`, which already
// returns a correct `stale` flag. The consumers W9 covers do not: they read
// `price_cache` rows directly — 21 closes for position sizing, 260 closes for the
// benchmark, the latest close as "current price" for rescore feedback and for
// display. On 2026-07-22 the cache froze for 101 of 140 symbols and every one of
// those reads kept returning a fixed number with no way to tell.
//
// The rule, and the reason it is date-based:
//
//   `lib/data/quotes.ts` derives staleness from the BAR'S MARKET DATE
//   (`data.date + "T20:00:00Z"`), never from `cached_at`. A row re-read or
//   re-written today is not fresh data. A bar is fresh iff its date is at least
//   the last completed regular session for its market.
//
// The verdict itself is NOT computed here — it is delegated to `assertFreshQuote`,
// the W1 boundary, so there is one rejection taxonomy for the whole codebase.
// This module's only job is to turn a bar into a `FreshnessCandidate` honestly.

import { assertFreshQuote, type FreshnessCandidate, type QuoteVerdict } from "@/lib/data/quote-freshness";
import { lastCompletedMarketSession } from "@/lib/trading/market-calendar";

/** The minimum a `price_cache` row must supply to be judged. */
export interface PriceCacheBar {
  date: string; // YYYY-MM-DD
  close: number | string | null | undefined;
}

/**
 * Is this bar's market date current enough to stand for "now"?
 *
 * `lastCompletedMarketSession` always steps back at least one calendar day, so
 * during a running session today's provisional bar is also fresh — which is what
 * we want for an EOD cache.
 */
export function isFreshSessionDate(date: string, market = "us", now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date >= lastCompletedMarketSession(market, now);
}

/**
 * Present a `price_cache` bar as something `assertFreshQuote` can judge.
 *
 * `retrievedAt` is the bar's own session close, not when we read the row. When
 * that instant has not arrived yet (a provisional bar for the running session)
 * it is stamped `now` instead — `assertFreshQuote` rejects future-dated
 * provenance, and a bar for today is fresh, not broken.
 */
export function priceCacheCandidate(
  bar: PriceCacheBar,
  market = "us",
  now: Date = new Date(),
): FreshnessCandidate {
  const closeInstant = `${bar.date}T20:00:00Z`;
  const closeMs = Date.parse(closeInstant);
  return {
    price: bar.close == null ? null : Number(bar.close),
    source: "price_cache",
    retrievedAt: Number.isFinite(closeMs) && closeMs > now.getTime() ? now.toISOString() : closeInstant,
    stale: !isFreshSessionDate(bar.date, market, now),
  };
}

/** Accept a `price_cache` bar as a current price, or reject it with a W1 reason. */
export function assertFreshBar(
  bar: PriceCacheBar | null | undefined,
  symbol: string,
  market = "us",
  now: Date = new Date(),
): QuoteVerdict {
  if (!bar || typeof bar.date !== "string") {
    return { ok: false, reason: "price_unavailable", detail: `${symbol}: no price_cache bar` };
  }
  return assertFreshQuote(priceCacheCandidate(bar, market, now), symbol);
}

/**
 * Freshness + coverage for a SERIES read out of `price_cache`.
 *
 * Coverage matters independently of freshness: a window can end on today's bar
 * and still be a handful of rows, and a statistic computed off that is not the
 * statistic the caller asked for. Both must hold before a series is usable.
 *
 * `bars` may be in any order; only the maximum date is consulted.
 */
export function assessSeries(
  bars: readonly PriceCacheBar[],
  opts: { symbol: string; market?: string; minBars: number; now?: Date },
): { ok: boolean; reason: "ok" | "no_data" | "insufficient_coverage" | "stale_series"; asOf: string | null; bars: number } {
  const market = opts.market ?? "us";
  const now = opts.now ?? new Date();
  const dated = bars.filter((b) => typeof b?.date === "string" && Number.isFinite(Number(b.close)) && Number(b.close) > 0);
  if (!dated.length) return { ok: false, reason: "no_data", asOf: null, bars: 0 };

  const asOf = dated.reduce((max, b) => (b.date > max ? b.date : max), dated[0].date);
  if (dated.length < opts.minBars) {
    return { ok: false, reason: "insufficient_coverage", asOf, bars: dated.length };
  }
  if (!isFreshSessionDate(asOf, market, now)) {
    return { ok: false, reason: "stale_series", asOf, bars: dated.length };
  }
  return { ok: true, reason: "ok", asOf, bars: dated.length };
}
