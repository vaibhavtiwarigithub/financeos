/**
 * Session-aligned quote cross-check.
 * features/quote-dispute-session-alignment/FEATURE_ARCHITECTURE.md
 *
 * THE DEFECT THIS EXISTS TO FIX. The mark cross-check compared a primary quote
 * against a second vendor's price WITHOUT requiring that the two describe the
 * same market session, then refused any pair more than
 * MARK_DISPUTE_REFUSE_PCT apart as a "vendor dispute". A cross feed one session
 * behind therefore manufactured a permanent dispute, and because a disputed
 * symbol is removed from priceMap BEFORE the exit loop, the position received
 * no stop, target or time-stop evaluation for as long as the lag persisted.
 *
 * Measured in production: INDUSTOWER.NS was refused on every run from
 * 2026-08-26 to 2026-09-01 on "yahoo_india 375 vs upstox 388.8 (3.549%)".
 * Yahoo's own closes were 375 on 2026-09-01 and 388.79998779296875 on
 * 2026-08-31 — the "disagreeing vendor price" was the primary's OWN previous
 * session, to four significant figures. The vendors did not disagree about a
 * price; they disagreed about which day it was, and two open positions went
 * seven days without exit evaluation as a result.
 *
 * Both sides already carried the session and both discarded it: Upstox candles
 * parse a `date` (lib/data/upstox.ts), and the Yahoo quote's `retrievedAt` is
 * `regularMarketTime` — the EXCHANGE timestamp of the quote, not our fetch time
 * (lib/india-data.ts).
 *
 * A date-mismatched cross is a cross that cannot be used, which the module's
 * own contract already calls "uncorroborated, never disputed". This makes that
 * true in code.
 */

export type CrossCheckVerdict =
  /** No second source this run. Mark recorded, exits evaluated. */
  | "no_cross"
  /** Cross exists but describes a different session — unusable, NOT a dispute. */
  | "session_mismatch"
  /** Same session, prices agree within tolerance. */
  | "agreed"
  /** Same session, apart by more than tolerance but under the refuse threshold. */
  | "divergent"
  /** Same session, grossly apart. Fail closed: refuse the price. */
  | "disputed";

export interface CrossCheckInput {
  live: number | null | undefined;
  cross: number | null | undefined;
  /** Exchange-local session date (YYYY-MM-DD) the primary price belongs to. */
  liveSession: string | null;
  /** Exchange-local session date (YYYY-MM-DD) the cross price belongs to. */
  crossSession: string | null;
  refusePct: number;
  tolerancePct: number;
}

export interface CrossCheckResult {
  verdict: CrossCheckVerdict;
  deltaPct: number | null;
  /** True only for `disputed`. The single flag callers gate money on. */
  refuse: boolean;
  liveSession: string | null;
  crossSession: string | null;
}

/**
 * The exchange-local calendar date an instant belongs to.
 *
 * Uses the EXCHANGE timezone, not UTC and not the server's. A US close at
 * 16:00 ET on 2026-09-01 is 20:00Z the same day, but an India close at 15:30
 * IST on 2026-09-01 is 10:00Z — and an India quote fetched at 23:00 IST is
 * already the NEXT UTC day. Comparing UTC dates would reintroduce exactly the
 * off-by-one-session error this module exists to remove.
 */
export function exchangeSessionDate(iso: string | null | undefined, market: "us" | "india"): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    // en-CA renders as YYYY-MM-DD, which sorts and compares as a plain string.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

export function classifyCrossCheck(input: CrossCheckInput): CrossCheckResult {
  const live = typeof input.live === "number" && Number.isFinite(input.live) && input.live > 0 ? input.live : null;
  const cross = typeof input.cross === "number" && Number.isFinite(input.cross) && input.cross > 0 ? input.cross : null;

  if (live == null || cross == null) {
    return { verdict: "no_cross", deltaPct: null, refuse: false, liveSession: input.liveSession, crossSession: input.crossSession };
  }

  // SESSION GATE, BEFORE ANY PRICE COMPARISON.
  //
  // An unknown session on either side is treated as a mismatch, not waved
  // through. Failing open here would restore the original bug for exactly the
  // rows whose provenance we cannot establish — and "we don't know when this
  // price is from" is not grounds to refuse a position's exits either, so it
  // lands on `session_mismatch`: uncorroborated, still priced, still evaluated.
  if (input.liveSession == null || input.crossSession == null || input.liveSession !== input.crossSession) {
    const deltaPct = (Math.abs(live - cross) / cross) * 100;
    return { verdict: "session_mismatch", deltaPct, refuse: false, liveSession: input.liveSession, crossSession: input.crossSession };
  }

  const deltaPct = (Math.abs(live - cross) / cross) * 100;
  const verdict: CrossCheckVerdict =
    deltaPct > input.refusePct ? "disputed"
      : deltaPct > input.tolerancePct ? "divergent"
        : "agreed";
  return { verdict, deltaPct, refuse: verdict === "disputed", liveSession: input.liveSession, crossSession: input.crossSession };
}

/**
 * How many whole days an unresolved dispute has been open.
 *
 * PositionMonitor runs once per market per day, so days are a faithful proxy
 * for consecutive runs and need no new per-symbol state table. It IS a proxy:
 * a skipped run (holiday, outage) counts as elapsed. That errs toward
 * escalating sooner, which is the safe direction when the thing being escalated
 * is a position with no exit evaluation.
 */
export function disputeAgeDays(firstSeenIso: string | null | undefined, now: Date): number {
  if (!firstSeenIso) return 0;
  const ms = Date.parse(firstSeenIso);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ms) / 86_400_000));
}

/**
 * Runs a dispute may persist before it stops being "today's data problem" and
 * becomes "this position has been unguarded for days".
 */
export const DISPUTE_ESCALATION_RUNS = 3;
