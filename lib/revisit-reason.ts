// Stock Context — "why revisit + when" (features/stock-context).
//
// PURE function. No I/O, no LLM, no DB. It derives a short human string and an
// urgency tag from data the app ALREADY has in the row: research_queue
// (priority, attempts, deferred_at), watchlist (alert_on_earnings, expires_at),
// and the cached profile's next_earnings_date.
//
// Display-only — off the money path. Never imported by scoring/order code.

export type RevisitUrgency = "high" | "medium" | "low" | "none";

export interface RevisitInput {
  // From symbol_profiles
  nextEarningsDate?: string | null; // YYYY-MM-DD
  // From watchlist
  alertOnEarnings?: boolean | null;
  expiresAt?: string | null; // timestamptz
  // From research_queue
  priority?: number | null;
  attempts?: number | null;
  deferredAt?: string | null; // timestamptz
  // From the latest signal/score, if known — how many days since last scored.
  scoreAgeDays?: number | null;
  // Threshold: a score older than this many days is "stale". Default 7.
  staleAfterDays?: number | null;
  // Injectable clock for deterministic tests. Defaults to Date.now().
  now?: Date;
}

export interface RevisitReason {
  reason: string;
  urgency: RevisitUrgency;
}

function daysUntil(dateStr: string, now: Date): number | null {
  const target = new Date(dateStr.length <= 10 ? dateStr + "T00:00:00Z" : dateStr).getTime();
  if (!Number.isFinite(target)) return null;
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - base) / 86400000);
}

function daysSince(dateStr: string, now: Date): number | null {
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}

// Compute the single most salient revisit reason. Precedence:
//   1. Imminent earnings (highest — time-boxed, actionable)
//   2. Watchlist entry expiring soon
//   3. Re-queued (deferred) — the agent didn't finish it
//   4. Stale score
//   5. Queue priority / general tracking
// Returns { reason: "", urgency: "none" } when nothing is worth surfacing.
export function computeRevisitReason(input: RevisitInput): RevisitReason {
  const now = input.now ?? new Date();
  const staleAfter = input.staleAfterDays ?? 7;

  // 1. Earnings proximity (only when we actually track earnings for this name).
  if (input.nextEarningsDate) {
    const d = daysUntil(input.nextEarningsDate, now);
    if (d != null && d >= 0 && d <= 14) {
      const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
      const flagged = input.alertOnEarnings ? " (earnings alert on)" : "";
      return { reason: `Earnings ${when}${flagged}`, urgency: d <= 3 ? "high" : "medium" };
    }
  }

  // 2. Watchlist row expiring soon (AI-scout auto-expiry etc.).
  if (input.expiresAt) {
    const d = daysUntil(input.expiresAt, now);
    if (d != null && d >= 0 && d <= 3) {
      const when = d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
      return { reason: `Watchlist entry expires ${when} — keep or drop`, urgency: "medium" };
    }
  }

  // 3. Re-queued (deferred by the wall-clock budget on a prior run).
  if (input.deferredAt) {
    const since = daysSince(input.deferredAt, now);
    const suffix = since != null && since >= 1 ? ` ${since}d ago` : "";
    return { reason: `Re-queued (deferred${suffix}) — awaiting re-score`, urgency: "medium" };
  }

  // 4. Stale score.
  if (input.scoreAgeDays != null && input.scoreAgeDays > staleAfter) {
    return { reason: `Score stale (>${staleAfter}d, last ${input.scoreAgeDays}d ago)`, urgency: "low" };
  }

  // 5. Elevated queue priority.
  if (input.priority != null && input.priority > 0) {
    const attemptsNote = input.attempts && input.attempts > 0 ? ` · ${input.attempts} attempt${input.attempts > 1 ? "s" : ""}` : "";
    return { reason: `Queued (priority ${input.priority}${attemptsNote})`, urgency: "low" };
  }

  return { reason: "", urgency: "none" };
}
