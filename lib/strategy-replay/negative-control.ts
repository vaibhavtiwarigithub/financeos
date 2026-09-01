// Negative controls for the replay seam.
//
// WHY. Step 3 of features/external-strategy-discovery exists to prove the
// orchestration seam is sound BEFORE any real strategy is judged by it. The only
// way to prove a measurement apparatus does not manufacture edge is to feed it
// something that cannot have any, and check that it reports none.
//
// This is the same discipline as the label-permutation placebo in
// lib/analytics/alpha-diagnostics-counterfactual.ts, applied one level up: there
// we permute outcomes, here we neuter the rule.
//
// If a control scores well, the seam is wrong. Do not debug the strategy —
// debug the seam.

import type { RuleSpec } from "./rule-spec";

/**
 * Deterministic coin flip from the session string.
 *
 * NOT `Math.random()`: a replay must be byte-reproducible, and an irreproducible
 * control cannot prove anything. FNV-1a over the session date, low bit.
 */
export function deterministicCoin(session: string, salt: string): boolean {
  let h = 0x811c9dc5;
  const text = `${salt}|${session}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) & 1) === 1;
}

/**
 * Control A — never trades.
 *
 * Must produce a flat NAV, zero fills, and a null Sharpe. If this reports a
 * return, the marking layer is inventing one.
 */
export function neverTradesControl(market: "us" | "india", universe: string[]): RuleSpec {
  return {
    id: "control_never_trades",
    label: "Negative control: never trades",
    role: "negative_control",
    market,
    universe,
    horizonSessions: 10,
    execution: "next_open",
    positionSizePct: 0.1,
    entry: { op: "never" },
    exit: { op: "always" },
    ruleVersion: "control_v1",
  };
}

/**
 * Control B — always in, exits only on the forced horizon.
 *
 * This is buy-and-hold-in-chunks. It is NOT expected to lose; it is expected to
 * approximate the benchmark net of costs. Its purpose is to catch a seam that
 * reports alpha for something carrying no selection at all: if this shows
 * material positive `netExcessReturnPp`, the benchmark comparison is broken.
 */
export function alwaysInControl(market: "us" | "india", universe: string[]): RuleSpec {
  return {
    id: "control_always_in",
    label: "Negative control: always in, horizon exit only",
    role: "negative_control",
    market,
    universe,
    horizonSessions: 10,
    execution: "next_open",
    // FULLY invested, split across the universe. The first version used 0.1
    // regardless of universe size, so on a single-symbol universe the "always
    // in" control ran at 8.7% utilisation and showed -81.58pp against a
    // benchmark it is supposed to track. A control that is not actually always
    // in cannot test whether the benchmark comparison works.
    positionSizePct: 1 / Math.max(1, universe.length),
    entry: { op: "always" },
    exit: { op: "never" },
    ruleVersion: "control_v2",
  };
}

/**
 * Control C — coin-flip entries.
 *
 * Expected: no edge, and critically no SYSTEMATIC edge across reruns, because
 * the coin is deterministic per session. A seam that rewards this is leaking
 * future information into the entry decision.
 *
 * Expressed as a spec the compiler can run: the coin is folded into the
 * predicate by the caller via `coinSessions`, because the predicate language is
 * deliberately data-only and has no random primitive.
 */
export function coinFlipSessions(sessions: readonly string[], salt = "control"): string[] {
  return sessions.filter((s) => deterministicCoin(s, salt));
}

export const NEGATIVE_CONTROL_IDS = [
  "control_never_trades",
  "control_always_in",
] as const;

export function isNegativeControl(specId: string): boolean {
  return (NEGATIVE_CONTROL_IDS as readonly string[]).includes(specId);
}
