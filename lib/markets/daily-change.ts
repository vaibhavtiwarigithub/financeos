// Daily-change primitives for the US markets overview.
//
// WHY THIS EXISTS
// ---------------
// A "daily change" is the latest session's close measured against the PRIOR
// session's close. It is NOT the latest session's open→close move (that is the
// intraday move, a different and usually smaller number, whose SIGN can differ
// from the daily change on any gap day).
//
// Verified against live Massive data for the 2026-07-15 session:
//   XLRE  open→close −0.11% (red)  |  close vs prior close +0.18% (green)
//   XLV   open→close +0.58% (green)|  close vs prior close  0.00% (flat)
// Two of fifteen tracked symbols had an inverted sign on a single ordinary
// session. Rendering open→close as "today" is therefore not a rounding issue —
// it can invert the direction the user sees.
//
// These helpers are pure so the arithmetic is unit-testable without network.

/** A session's close, tagged with the ET calendar date the session belongs to. */
export interface LatestBar {
  symbol: string;
  close: number;
  /** ET calendar date (YYYY-MM-DD) of the session this close belongs to. */
  sessionDate: string;
}

export type QuoteStatus = "ok" | "unavailable";

export interface Quote {
  symbol: string;
  name: string;
  /** null when unavailable — never 0, so "no data" cannot render as a real price. */
  price: number | null;
  change: number | null;
  changePct: number | null;
  status: QuoteStatus;
  /** Human-readable cause, present only when status === "unavailable". */
  reason?: string;
}

/**
 * ET calendar date (YYYY-MM-DD) for a unix-ms timestamp.
 *
 * Massive's daily bars are timestamped inconsistently across endpoints — the
 * grouped endpoint stamps a session at 16:00 ET (close of window) while the
 * range endpoint stamps the SAME session at 00:00 ET (start of window).
 * Converting to the ET calendar date normalizes both to the same session date,
 * so this is deliberately timezone-based rather than arithmetic on the epoch.
 */
export function etCalendarDate(ms: number): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** The calendar day before `date` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function previousCalendarDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  // Noon UTC anchor keeps the arithmetic clear of any DST edge.
  const t = Date.UTC(y, m - 1, d, 12) - 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

/** True for Saturday/Sunday — cheap pre-filter before spending a grouped request. */
export function isWeekend(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Candidate session dates INCLUDING `from`, newest first, skipping weekends.
 * Holidays and not-yet-published sessions cannot be detected from a calendar —
 * the caller probes each date and keeps the ones that return bars.
 */
export function sessionCandidates(from: string, max = 8): string[] {
  const out: string[] = [];
  let d = from;
  for (let i = 0; i < max * 2 && out.length < max; i++) {
    if (!isWeekend(d)) out.push(d);
    d = previousCalendarDate(d);
  }
  return out;
}

/**
 * Candidate prior-session dates, newest first, skipping weekends — i.e.
 * sessionCandidates starting the day BEFORE `sessionDate`.
 */
export function priorSessionCandidates(sessionDate: string, max = 6): string[] {
  return sessionCandidates(previousCalendarDate(sessionDate), max);
}

/**
 * Daily change: close vs PRIOR close. Returns null when the prior close is
 * missing or unusable, so the caller must render "unavailable" rather than 0.
 */
export function computeDailyChange(
  close: number,
  priorClose: number | null | undefined
): { change: number; changePct: number } | null {
  if (priorClose == null || !Number.isFinite(priorClose) || priorClose <= 0) return null;
  if (!Number.isFinite(close)) return null;
  const change = close - priorClose;
  return {
    change: round2(change),
    changePct: round2((change / priorClose) * 100),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build a display quote, collapsing every failure mode into an explicit status. */
export function buildQuote(
  symbol: string,
  name: string,
  bar: LatestBar | null,
  priorClose: number | null | undefined,
  reason?: string
): Quote {
  if (!bar) {
    return {
      symbol,
      name,
      price: null,
      change: null,
      changePct: null,
      status: "unavailable",
      reason: reason ?? "quote unavailable",
    };
  }
  const daily = computeDailyChange(bar.close, priorClose);
  if (!daily) {
    return {
      symbol,
      name,
      price: round2(bar.close),
      change: null,
      changePct: null,
      status: "unavailable",
      reason: "prior close unavailable — daily change cannot be computed",
    };
  }
  return {
    symbol,
    name,
    price: round2(bar.close),
    change: daily.change,
    changePct: daily.changePct,
    status: "ok",
  };
}
