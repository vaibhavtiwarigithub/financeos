// Frozen rule specification for external-strategy replay.
//
// A spec is the COMPLETE identity of one tested thing. Two specs that differ in
// any parameter, in execution timing, or in the universe they run on are
// different trials and must fingerprint apart — the trial-family ledger's
// idempotency depends on it.
//
// LEGAL NOTE. `sourceUrl` and `sourceName` are attribution only. A spec records
// atomic functional facts (indicator, comparator, threshold, execution timing).
// It must never contain the source article's prose, explanation or illustration.
// See features/external-strategy-discovery section 1.
//
// MEASURE-ONLY. Nothing here is read by a scorer, PaperTrader, PositionMonitor,
// proposal, order or broker path.

import { canonicalize, fingerprint } from "@/lib/analytics/alpha-diagnostic-contract";

/** When the rule is allowed to act relative to the bar that produced the signal. */
export type ExecutionTiming =
  /** Act on the same bar's close. Only valid when the signal does not use that
   *  close — otherwise it is look-ahead. */
  | "same_close"
  /** Act at the next session's open. Required whenever the signal consumes the
   *  closing price of the signal bar. */
  | "next_open";

export type RuleRole =
  | "entry"
  | "exit"
  | "exposure_overlay"
  | "defensive_allocator"
  /** Deliberately worthless. Used to prove the seam does not manufacture edge. */
  | "negative_control";

export interface RuleSpec {
  /** Stable slug. Part of the fingerprint. */
  id: string;
  label: string;
  role: RuleRole;
  market: "us" | "india";
  /** Symbols the rule is defined on. Frozen — a different universe is a new trial. */
  universe: string[];
  /** Holding horizon in MARKET SESSIONS, never calendar days. */
  horizonSessions: number;
  execution: ExecutionTiming;
  /** Fraction of starting capital per position, 0-1. */
  positionSizePct: number;
  /** Declarative predicate tree. Kept data, not code, so it can be fingerprinted
   *  and stored. Evaluated by ./compile.ts. */
  entry: Predicate;
  exit: Predicate;
  /** Attribution only. Never article text. */
  sourceName?: string;
  sourceUrl?: string;
  /** Set when this is an adaptation of another spec (e.g. next-open execution of
   *  a published close-entry rule). Adaptations are NEW trials. */
  adaptedFrom?: string;
  /** Bumped whenever the compiler's interpretation of a predicate changes. */
  ruleVersion: string;
}

export type Predicate =
  | { op: "always" }
  | { op: "never" }
  | { op: "and"; terms: Predicate[] }
  | { op: "or"; terms: Predicate[] }
  | { op: "not"; term: Predicate }
  /** Indicator compared to a constant. */
  | { op: "cmp"; left: Indicator; cmp: "<" | "<=" | ">" | ">="; right: number }
  /** Indicator compared to another indicator. */
  | { op: "cmp2"; left: Indicator; cmp: "<" | "<=" | ">" | ">="; right: Indicator }
  /** Bars held since entry, in sessions. Exit-only. */
  | { op: "held_sessions"; cmp: ">=" | ">"; value: number };

export type Indicator =
  | { fn: "close" }
  | { fn: "open" }
  | { fn: "sma"; period: number }
  | { fn: "rsi"; period: number }
  /** True range of the last `period` bars, as a fraction of close. */
  | { fn: "range_pct"; period: number }
  /** Narrowest range in `period` bars (NR-n family): 1 when today's range is the
   *  smallest of the window, else 0. */
  | { fn: "is_narrowest_range"; period: number }
  /** Percent return from entry price. Exit-only. */
  | { fn: "return_pct_from_entry" };

/**
 * Canonical 64-hex identity of a spec.
 *
 * Deliberately covers EVERY field including `execution` and `universe`: the
 * review's point that "Turnaround Tuesday, adapted to next-open" is a new
 * specification and must increment the trial count depends on execution timing
 * being inside the fingerprint.
 */
export function specFingerprint(spec: RuleSpec): string {
  return fingerprint({
    id: spec.id,
    role: spec.role,
    market: spec.market,
    universe: [...spec.universe].sort(),
    horizonSessions: spec.horizonSessions,
    execution: spec.execution,
    positionSizePct: spec.positionSizePct,
    entry: spec.entry,
    exit: spec.exit,
    ruleVersion: spec.ruleVersion,
  });
}

/** Stable serialization for storage and diffing. */
export function serializeSpec(spec: RuleSpec): string {
  return canonicalize(spec);
}

/**
 * Reject a spec whose signal consumes the same close it trades on.
 *
 * The catalogue's own Turnaround Tuesday article acknowledges this look-ahead.
 * A rule that reads `close` and executes at `same_close` cannot be traded as
 * described, so the compiler refuses it rather than producing a flattering
 * number nobody can act on.
 */
export function validateSpec(spec: RuleSpec): string[] {
  const errors: string[] = [];
  if (!(spec.positionSizePct > 0 && spec.positionSizePct <= 1)) {
    errors.push("positionSizePct must be in (0, 1]");
  }
  if (!Number.isInteger(spec.horizonSessions) || spec.horizonSessions < 1) {
    errors.push("horizonSessions must be a positive integer number of sessions");
  }
  if (spec.universe.length === 0) errors.push("universe must not be empty");
  if (spec.execution === "same_close" && usesClose(spec.entry)) {
    errors.push(
      "look-ahead: entry predicate reads `close` but execution is `same_close`; use `next_open`",
    );
  }
  return errors;
}

function usesClose(p: Predicate): boolean {
  switch (p.op) {
    case "and": case "or": return p.terms.some(usesClose);
    case "not": return usesClose(p.term);
    case "cmp": return indicatorUsesClose(p.left);
    case "cmp2": return indicatorUsesClose(p.left) || indicatorUsesClose(p.right);
    default: return false;
  }
}

function indicatorUsesClose(i: Indicator): boolean {
  // sma/rsi/range are derived FROM closes, so a predicate using them on the
  // signal bar also consumes that bar's close.
  return i.fn === "close" || i.fn === "sma" || i.fn === "rsi"
    || i.fn === "range_pct" || i.fn === "is_narrowest_range";
}
