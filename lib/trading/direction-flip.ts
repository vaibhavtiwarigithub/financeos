// Direction-flip exit decision (pure).
//
// A "direction flip" = a position held long whose FRESH research signal now
// points short below the exit threshold. Historically the monitor force-sold on
// the FIRST such session, which produced whipsaw: 13 of 22 closed paper trades
// (2026-07) exited on a same-week flip for a ~1% loss before any thesis played
// out — one India name flipped 1.3 days after entry.
//
// This tightens it two ways, both enforced here:
//   1. Min-hold floor — a flip on a position younger than `minHoldDays` market
//      days is ignored (too young to trust a reversal).
//   2. Cross-session persistence — the first qualifying flip only ARMS the exit
//      (a staged flag carrying the score session that armed it). The exit
//      CONFIRMS only when a strictly NEWER research session still shows the
//      flip. A one-session score wobble reverts and disarms; a real regime
//      change persists into the next cycle and sells.
//
// Keeping the decision pure means the persistence rule is testable without the
// DB/route around it (see direction-flip.test.ts).

export type FlipAction =
  | "confirm"    // armed + a newer session still flips → close now
  | "arm"        // first qualifying flip → stage, do not sell yet
  | "disarm"     // armed but the flip is gone → clear the flag, hold
  | "too_young"  // flip present but held < minHoldDays → ignore
  | "hold";      // nothing to do (no flip, or armed and waiting for a new session)

export interface FlipDecisionInput {
  /** Fresh signal is a held short below the exit threshold (the raw flip test). */
  flipped: boolean;
  /** Market days the position has been held, or null if the open time is unknown. */
  ageDays: number | null;
  /** Minimum market days held before a flip may arm. */
  minHoldDays: number;
  /** The score session (ISO timestamp) that armed the flip, or null if not armed. */
  armedSession: string | null;
  /** The current fresh score's session (ISO timestamp), or null if none. */
  currentSession: string | null;
}

export function decideDirectionFlip(i: FlipDecisionInput): FlipAction {
  if (i.armedSession != null) {
    if (!i.flipped) return "disarm";
    // Confirm only when a STRICTLY NEWER research session still shows the flip.
    // ISO-8601 timestamps compare lexicographically, so string > is correct.
    if (i.currentSession != null && i.currentSession > i.armedSession) return "confirm";
    return "hold"; // still flipped, but no fresh session since arming — wait
  }
  if (!i.flipped) return "hold";
  if (i.ageDays != null && i.ageDays < i.minHoldDays) return "too_young";
  return "arm";
}

/** Default min-hold floor (market days) before a flip may arm. */
export const MIN_FLIP_HOLD_DAYS = 2;

/** Staged-flag prefix stored in paper_positions.exit_reason while a flip is armed. */
export const FLIP_ARMED_PREFIX = "direction_flip_armed";

/** Build the armed flag carrying the arming session. */
export function armedFlag(session: string | null | undefined): string {
  return `${FLIP_ARMED_PREFIX}:${session ?? ""}`;
}

/** Parse the arming session out of an armed flag, or null if the string isn't one. */
export function parseArmedSession(exitReason: unknown): string | null {
  if (typeof exitReason !== "string" || !exitReason.startsWith(`${FLIP_ARMED_PREFIX}:`)) return null;
  return exitReason.slice(FLIP_ARMED_PREFIX.length + 1) || "";
}
