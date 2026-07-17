// Research annotation for the Risk Analytics surface — a DISPLAY JOIN, nothing more.
//
// WHY THIS EXISTS
// ---------------
// On 2026-07-16 AVGO was SIX DAYS UNSCORED while Risk Analytics told the owner to
// trim it, and nothing on screen said so. A score with no age is how that hid: a
// 6-day-old 91 and a fresh 91 are not the same claim. **The age is the feature,
// not the score.**
//
// THE INVARIANT (R1) — read before changing anything here
// ------------------------------------------------------
// Research does NOT enter the risk computation. Nothing this module produces may
// be read by `computeHoldingRisk`, `sba-v1` (lib/risk/sector-breach.ts),
// `constructPortfolio`, the execution kernel, or any gate.
//
// The risk engine is research-free BY DESIGN. A sector is over-cap *because*
// research liked that sector — letting `analyst_score` also veto the cap
// double-counts the same signal. The risk layer exists to be the one thing not
// persuaded by the score. The owner integrates the two views; that is where
// judgment belongs.
//
// `tests/risk-research-annotation.test.ts` (T1) pins this both behaviorally and
// architecturally. If you are here to wire the score into a risk decision, that
// test is not an obstacle to route around — it is the design.
//
// STALENESS IS MEASURED IN SESSIONS, DISPLAYED IN DAYS
// ---------------------------------------------------
// A Friday score read on Monday is 3 calendar days but ONE session. A
// calendar-day rule paints the whole book stale every Monday and trains the owner
// to ignore the warning. US and India have different calendars and holidays, so
// the market-local session helper (`marketSessionsSince`) is authoritative — do
// NOT reimplement a weekday count here. T3 pins this.

import { marketSessionsSince } from "@/lib/trading/paper-exit-policy";

/**
 * Sessions before a score is called stale. DECIDED = 2 (owner, 2026-07-17).
 *
 * The merged holdings rotation bounds worst-case staleness at ~2 runs, so 1 would
 * flag ordinary rotation lag as a warning (noise) and train the owner to ignore
 * it. 2 flags only genuine starvation — which is what AVGO actually was.
 */
export const STALE_AFTER_SESSIONS = 2;

/** Four states. They are NOT interchangeable — collapsing them is the bug class this removes. */
export type ResearchState =
  /** Scored within STALE_AFTER_SESSIONS market-local sessions. */
  | "fresh"
  /** Scored, but longer ago than the threshold — the AVGO case. Warning + day count. */
  | "stale"
  /** No signal has EVER existed for this (symbol, market). Not stale, not a zero, and NOT a link. */
  | "never"
  /** Research ran and abstained on thin evidence. Never rendered as a number. */
  | "unavailable";

export type ResearchDirection = "long" | "neutral" | "short";

/** The nullable per-holding block the risk API adds. Additive; read by the UI only. */
export interface ResearchBlock {
  score: number | null;
  direction: ResearchDirection | null;
  /** ISO timestamp of the scoring run. */
  scored_at: string | null;
  /** Market-local sessions elapsed — the honest staleness measure. */
  sessions_since: number | null;
  /** Calendar days elapsed — display only, because "N days ago" is what reads plainly. */
  days_since: number | null;
  state: ResearchState;
  /**
   * Whether research scored this symbol AS A HOLDING (`is_holding`), or as a
   * screener candidate.
   *
   * This changes what the score MEANS. The direction gate can only emit `short`
   * (a deterministic exit) when the symbol was scored as held. So a `neutral`
   * from the screener path does NOT mean "no exit signal" — it means the question
   * was never asked. Every agent_signals row in prod is `is_holding:false`
   * (463/463 as of 2026-07-17), so this is the common case, not the edge. T7 pins it.
   */
  scored_as_holding: boolean | null;
}

/** The subset of an `agent_signals` row this join needs. */
export interface ResearchSignalRow {
  symbol: string;
  market: string;
  analyst_score: number | null;
  direction: string | null;
  created_at: string | null;
  is_holding: boolean | null;
}

const DIRECTIONS: ReadonlySet<string> = new Set(["long", "neutral", "short"]);

function normalizeDirection(d: string | null): ResearchDirection | null {
  return d != null && DIRECTIONS.has(d) ? (d as ResearchDirection) : null;
}

/**
 * Join key. `market` is authoritative and is never dropped: US and India books
 * must not cross-join, and per-market/per-currency figures are never cross-summed.
 * NUL-separated so a symbol containing the separator cannot forge a collision.
 */
export function researchKey(symbol: string, market: string): string {
  return `${symbol}\u0000${market}`;
}

/**
 * Latest signal per (symbol, market). Expects rows ordered newest-first; the
 * first row seen per key wins. Callers that cannot guarantee order should sort.
 */
export function indexLatestSignals(rows: readonly ResearchSignalRow[]): Map<string, ResearchSignalRow> {
  const out = new Map<string, ResearchSignalRow>();
  for (const r of rows) {
    if (r?.symbol == null || r?.market == null) continue;
    const k = researchKey(r.symbol, r.market);
    if (!out.has(k)) out.set(k, r);
  }
  return out;
}

/** Market-local calendar date (YYYY-MM-DD), or null when the instant is unusable. */
function marketDate(date: Date, market: "us" | "india"): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  const y = get("year"), m = get("month"), d = get("day");
  return y && m && d ? `${y}-${m}-${d}` : null;
}

/**
 * Calendar days elapsed, market-local — DISPLAY ONLY.
 *
 * Never feed this to the staleness decision: that is `sessions_since`'s job, and
 * conflating them is exactly the Monday-noise bug described at the top.
 */
function marketDaysSince(createdAt: string, now: Date, market: "us" | "india"): number | null {
  const startYmd = marketDate(new Date(createdAt), market);
  const endYmd = marketDate(now, market);
  if (!startYmd || !endYmd) return null;
  const start = Date.parse(`${startYmd}T00:00:00Z`);
  const end = Date.parse(`${endYmd}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const days = Math.round((end - start) / 86_400_000);
  return days < 0 ? null : days;
}

/**
 * Build the display block for one holding.
 *
 * `sig` is the latest signal for this (symbol, market), or null/undefined when
 * none has ever existed.
 */
export function buildResearchBlock(
  sig: ResearchSignalRow | null | undefined,
  now: Date,
  market: "us" | "india",
  staleAfterSessions: number = STALE_AFTER_SESSIONS,
): ResearchBlock {
  // `never` — no signal has ever existed. Distinct from stale (we have nothing,
  // not something old) and from unavailable (research never spoke at all).
  if (sig == null) {
    return {
      score: null, direction: null, scored_at: null,
      sessions_since: null, days_since: null,
      state: "never", scored_as_holding: null,
    };
  }

  const scoreOk = typeof sig.analyst_score === "number" && Number.isFinite(sig.analyst_score);
  const scoredAt = sig.created_at ?? null;

  // `unavailable` — research ran but produced no usable number (abstained on thin
  // evidence). Must NEVER be rendered as a number: a default-filled 50 is not
  // evidence, and neither is a null coerced to 0.
  //
  // NOTE (verified 2026-07-17): prod currently has ZERO such rows — agent_signals
  // has no abstain representation, so every row carries a score. This branch is
  // defensive: if research ever writes a null score, it must degrade honestly
  // rather than render as 0. T5 pins the behavior against a fixture.
  if (!scoreOk || scoredAt == null) {
    return {
      score: null,
      direction: normalizeDirection(sig.direction),
      scored_at: scoredAt,
      sessions_since: null, days_since: null,
      state: "unavailable",
      scored_as_holding: sig.is_holding ?? null,
    };
  }

  const sessions = marketSessionsSince(scoredAt, now, market);
  const sessionsFinite = Number.isFinite(sessions) ? sessions : null;
  const days = marketDaysSince(scoredAt, now, market);

  // Threshold is inclusive: <= staleAfterSessions is fresh. An unusable session
  // count (future timestamp / unparseable) fails toward `stale` — the honest
  // direction, since we cannot prove the score is current.
  const state: ResearchState = sessionsFinite != null && sessionsFinite <= staleAfterSessions ? "fresh" : "stale";

  return {
    score: sig.analyst_score as number,
    direction: normalizeDirection(sig.direction),
    scored_at: scoredAt,
    sessions_since: sessionsFinite,
    days_since: days,
    state,
    scored_as_holding: sig.is_holding ?? null,
  };
}

/**
 * Human sentence for the annotation. Per CLAUDE.md "Detail Over Cryptic": the
 * cell must say what/why, never a bare number or a bare status string.
 */
export function researchStateSentence(b: ResearchBlock): string {
  switch (b.state) {
    case "never":
      return "Never scored — research has no signal on record for this symbol in this market.";
    case "unavailable":
      return "Research ran but abstained on thin evidence — there is no score to show.";
    case "stale": {
      const d = b.days_since;
      const age = d == null ? "an unknown time" : `${d} day${d === 1 ? "" : "s"}`;
      return `Not scored in ${age} — this score is older than ${STALE_AFTER_SESSIONS} trading sessions and may not reflect current evidence.`;
    }
    case "fresh": {
      const d = b.days_since;
      if (d == null) return "Scored recently.";
      return d === 0 ? "Scored today." : `Scored ${d} day${d === 1 ? "" : "s"} ago.`;
    }
  }
}

/** `never` is not a link — a link to nothing is a lie. */
export function isResearchLinkable(b: ResearchBlock | null | undefined): boolean {
  return b != null && b.state !== "never";
}
