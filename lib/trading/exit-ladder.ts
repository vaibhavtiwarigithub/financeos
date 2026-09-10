// Shared exit-ladder decision core — the SINGLE implementation of what an
// open position should do next, used by BOTH the paper monitor and the live
// monitor.
//
// features/live-exit-ladder-parity/FEATURE_ARCHITECTURE.md.
//
// WHY THIS EXISTS. Paper (position-monitor) took partial profit at target and
// trailed a stop behind the runner; live (live-exit-monitor) closed the whole
// position at target and never moved its stop. Same nominal policy, two
// implementations, materially different behavior — a live winner banked less
// and a live runner kept its entry-day stop forever.
//
// Parity is not "write the same rules twice and keep them in sync". Parity is
// ONE function both callers pass their state into. If this returns the same
// decision for the same inputs, paper and live cannot diverge, because there
// is nothing left to diverge.
//
// This module is pure: no DB, no clock, no provider. Everything time- or
// state-dependent is an argument, so the parity test can drive both engines
// through identical price paths without mocking anything.

import { paperPartialTargetQuantity, paperRunnerStopPrice, type PaperQuantityMarket } from "@/lib/trading/paper-quantity";

export type ExitAction =
  | "none"
  /** Trailing stop breached — close the whole position. */
  | "stop_full"
  /** Target reached, partial not yet taken — sell part, protect the runner. */
  | "partial_target"
  /** Target reached but the position cannot be split — close it all. */
  | "target_full"
  /** Held past its horizon — close the whole position. */
  | "time_stop"
  /** Target reached and the partial already fired — the runner rides the trail. */
  | "runner_hold";

export interface ExitLadderInput {
  market: PaperQuantityMarket;
  /** Current quantity held. */
  qty: number;
  /** Average entry price for the position. */
  avgEntry: number;
  /** Latest price. */
  price: number;
  /**
   * Lowest price to consider for a stop touch this session. Paper passes
   * min(close, session low) so an intraday touch that recovered by close still
   * counts; live passes the current price when no session low is available.
   */
  stopCheckPrice?: number;
  /** Price target. Null disables the target branch entirely. */
  priceTarget: number | null;
  /**
   * The position's ORIGINAL stop, preserved from entry. The trail distance is
   * derived from this rather than a hardcoded percentage, so a volatile name
   * that entered with a 12% stop keeps a 12% trail and a tight 4% stop keeps 4%.
   */
  initialStopLoss: number | null;
  /** Current stop. A trail may raise this; nothing may lower it. */
  currentStop: number | null;
  /** Highest price seen since entry. */
  highestPrice: number | null;
  /** Whole market days held. */
  ageDays: number;
  /** Horizon after which the time stop fires. */
  horizonDays: number;
  /** True once the partial target has fired for THIS position. */
  partialTaken: boolean;
  /** Hedges never take partial profit. */
  isHedge?: boolean;
}

export interface ExitLadderDecision {
  action: ExitAction;
  reason: string | null;
  /** Quantity to exit. Undefined for actions that exit nothing. */
  exitQty?: number;
  /** Stop to persist for the surviving runner after a partial. */
  runnerStop?: number;
  /** Recomputed trailing stop — persist this every run, exit or not. */
  trailingStop: number;
  /** Recomputed high-water mark — persist this every run. */
  highestPrice: number;
  /** Outcome label for the ledger, when this action closes something. */
  outcome?: "win" | "loss";
}

/** Fraction of the high-water mark the trail sits at, from the position's own stop distance. */
export function trailAnchorPct(initialStopLoss: number | null, avgEntry: number): number {
  if (initialStopLoss == null || !(avgEntry > 0)) return 0.93;
  return Math.min(0.99, Math.max(0.5, initialStopLoss / avgEntry));
}

/**
 * Decide what an open position does next.
 *
 * Precedence is stop → target → time, matching paper's existing order. Stop
 * wins over target deliberately: if a bar both breached the stop and touched
 * the target, the protective exit is the honest assumption, not the profitable
 * one.
 */
export function decideExitLadder(input: ExitLadderInput): ExitLadderDecision {
  const highestPrice = Math.max(input.highestPrice ?? input.avgEntry, input.price);
  const anchorPct = trailAnchorPct(input.initialStopLoss, input.avgEntry);

  // Never lower an existing stop. A trail only ratchets up.
  const trailingStop = Math.max(
    input.currentStop ?? input.avgEntry * anchorPct,
    highestPrice * anchorPct,
  );

  const base = { trailingStop, highestPrice };
  const stopCheckPrice = input.stopCheckPrice ?? input.price;

  if (stopCheckPrice <= trailingStop) {
    return {
      ...base,
      action: "stop_full",
      reason: stopCheckPrice < input.price
        ? `stop hit intraday: ${stopCheckPrice.toFixed(2)} <= ${trailingStop.toFixed(2)}`
        : `stop: ${stopCheckPrice.toFixed(2)} <= ${trailingStop.toFixed(2)} (entry ${input.avgEntry.toFixed(2)})`,
      exitQty: input.qty,
      outcome: trailingStop > input.avgEntry ? "win" : "loss",
    };
  }

  if (!input.isHedge && input.priceTarget != null && input.price >= input.priceTarget) {
    if (input.partialTaken) {
      // Already banked half. The remainder is managed by the trail above —
      // re-selling here every run is exactly the bleed this flag prevents.
      return { ...base, action: "runner_hold", reason: `target held: partial already taken, runner trails at ${trailingStop.toFixed(2)}` };
    }
    const partialQty = paperPartialTargetQuantity(input.market, input.qty);
    if (partialQty != null && partialQty < input.qty) {
      const runnerStop = paperRunnerStopPrice(input.avgEntry, trailingStop) ?? input.avgEntry;
      return {
        ...base,
        action: "partial_target",
        reason: `target: ${input.price.toFixed(2)} >= ${input.priceTarget.toFixed(2)} — banking ${partialQty}, runner protected at ${runnerStop.toFixed(2)}`,
        exitQty: partialQty,
        runnerStop,
        outcome: "win",
      };
    }
    return {
      ...base,
      action: "target_full",
      reason: `target: ${input.price.toFixed(2)} >= ${input.priceTarget.toFixed(2)} — position too small to split`,
      exitQty: input.qty,
      outcome: "win",
    };
  }

  if (input.ageDays > input.horizonDays) {
    return {
      ...base,
      action: "time_stop",
      reason: `time stop: age ${input.ageDays} market days > ${input.horizonDays}d`,
      exitQty: input.qty,
      outcome: input.price > input.avgEntry ? "win" : "loss",
    };
  }

  return { ...base, action: "none", reason: null };
}
