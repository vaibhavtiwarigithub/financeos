// Hybrid protective stops — REQUIRED STATE MODEL (shadow scaffold).
//
// The authoritative `protective_order` record shape, its status machine, exit
// provenance, and the long-only / cancel-before-replace invariants. Pure types +
// deterministic helpers — NO broker calls, NO placement, NO LLM.
//
// The record REFERENCES the existing position and execution ledger. It must NOT
// create a parallel position, cash, or P&L truth layer.

import { DisasterFloorMode } from "@/lib/protective/disaster-floor";
import { Market, ProtectiveOrderKind } from "@/lib/protective/capabilities";

export type ProtectiveOrderStatus =
  | "placing"
  | "active"
  | "triggered"
  | "filled"
  | "canceling"
  | "canceled"
  | "failed"
  | "needs_reconcile";

export const PROTECTIVE_TERMINAL_STATUSES: ProtectiveOrderStatus[] = ["filled", "canceled", "failed"];

// EXIT PROVENANCE (Codex's correction). A disaster-floor fill closes the position
// with this DISTINCT reason — separate from every strategy exit (stop, target,
// trailing, thesis, time). The loss is REAL money: it stays in P&L, NAV,
// drawdown, mandate evaluation, and risk-policy evaluation. ONLY the Learner's
// signal-weight attribution excludes it, so broker capability cannot contaminate
// weight learning.
export const PROTECTIVE_EXIT_REASON = "protective_disaster_floor";

// Explicit learning-attribution scope. A generic `excluded_from_learning = true`
// is INSUFFICIENT because the existing evaluation engine ALSO filters that field,
// which would wrongly drop the loss from risk-policy/drawdown evaluation too. So
// a disaster-floor fill is `risk_policy_only`: counted for risk/P&L/drawdown,
// excluded ONLY from signal-weight attribution and genome promotion.
export const LEARNING_SCOPE_FULL = "full";
export const LEARNING_SCOPE_RISK_POLICY_ONLY = "risk_policy_only";
export type LearningScope = typeof LEARNING_SCOPE_FULL | typeof LEARNING_SCOPE_RISK_POLICY_ONLY;

// One authoritative record per live position and broker.
export interface ProtectiveOrderRecord {
  positionId: string;
  brokerAccountId: string;
  market: Market;
  symbol: string;
  // broker_order_id OR Kite trigger_id — exactly one identifies the resting order.
  brokerOrderId: string | null;
  kiteTriggerId: string | null;
  mode: DisasterFloorMode;
  orderKind: ProtectiveOrderKind;
  analyticalStop: number;
  brokerFloor: number;
  triggerPrice: number;
  limitPrice: number | null;
  status: ProtectiveOrderStatus;
  // Reconciled protected quantity — never exceeds the reconciled held quantity.
  protectedQty: number;
  reconciledHeldQty: number;
  brokerVersion: string | null;
  brokerUpdatedAt: string | null;
  expiry: string | null;
  lastReconciledAt: string | null;
  // Immutable reason + correlation/idempotency id.
  reason: string;
  correlationId: string;
}

// Allowed status transitions. `needs_reconcile` is reachable from any non-terminal
// state on unknown broker state (never assume active or canceled). Terminal states
// have no outgoing transitions.
const TRANSITIONS: Record<ProtectiveOrderStatus, ProtectiveOrderStatus[]> = {
  placing: ["active", "failed", "needs_reconcile"],
  active: ["triggered", "canceling", "canceled", "filled", "needs_reconcile"],
  triggered: ["filled", "needs_reconcile", "canceled"],
  canceling: ["canceled", "needs_reconcile", "failed"],
  needs_reconcile: ["active", "triggered", "filled", "canceled", "failed"],
  filled: [],
  canceled: [],
  failed: [],
};

export function canTransition(from: ProtectiveOrderStatus, to: ProtectiveOrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: ProtectiveOrderStatus): boolean {
  return PROTECTIVE_TERMINAL_STATUSES.includes(status);
}

// ── Exit provenance / learning attribution ────────────────────────────────────

export function learningScopeForExit(exitReason: string | null | undefined): LearningScope {
  return exitReason === PROTECTIVE_EXIT_REASON ? LEARNING_SCOPE_RISK_POLICY_ONLY : LEARNING_SCOPE_FULL;
}

// A disaster-floor fill is EXCLUDED from signal-weight attribution / genome
// promotion. Everything else (or an unstamped legacy row) is included.
export function includedInSignalWeightLearning(row: {
  exit_reason?: string | null;
  learning_scope?: string | null;
}): boolean {
  const scope = row.learning_scope ?? (row.exit_reason ? learningScopeForExit(row.exit_reason) : LEARNING_SCOPE_FULL);
  return scope !== LEARNING_SCOPE_RISK_POLICY_ONLY;
}

// P&L / NAV / drawdown / risk-policy ALWAYS include a real fill — a disaster-floor
// loss is real money and is never dropped from these. This exists so the
// distinction is testable and cannot be "optimized" into the weight-exclusion.
export function includedInPnlAndRisk(_row: { exit_reason?: string | null; learning_scope?: string | null }): boolean {
  return true;
}

// ── Long-only / cancel-before-replace invariants ──────────────────────────────

// Total executable SELL quantity (resting protective SELL + any competing/new
// SELL) can never exceed the reconciled held quantity — else an accidental short.
export function totalExecutableSellExceedsHeld(opts: {
  reconciledHeldQty: number;
  restingProtectiveQty: number;
  competingSellQty: number;
}): boolean {
  return opts.restingProtectiveQty + opts.competingSellQty > opts.reconciledHeldQty;
}

// Gate a competing SELL (explicit exit or a cancel/replace). FAIL CLOSED:
//   - If resting protection exists and its cancellation is NOT confirmed, block —
//     submitting a SELL alongside a live protective SELL can exceed held qty and
//     create a short (covers acceptance tests 1 & 2).
//   - After confirmed cancellation, the SELL may proceed only up to held qty.
export function canSubmitCompetingSell(opts: {
  reconciledHeldQty: number;
  restingProtectiveQty: number;
  restingCancellationConfirmed: boolean;
  requestedSellQty: number;
}): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(opts.requestedSellQty) || opts.requestedSellQty <= 0) {
    return { ok: false, reason: "requested SELL qty must be a positive finite number" };
  }
  if (opts.restingProtectiveQty > 0 && !opts.restingCancellationConfirmed) {
    return {
      ok: false,
      reason:
        "resting protective SELL exists and its cancellation is NOT confirmed — refusing a competing SELL (would risk an accidental short)",
    };
  }
  // Effective resting after a confirmed cancellation is zero.
  const effectiveResting = opts.restingCancellationConfirmed ? 0 : opts.restingProtectiveQty;
  if (
    totalExecutableSellExceedsHeld({
      reconciledHeldQty: opts.reconciledHeldQty,
      restingProtectiveQty: effectiveResting,
      competingSellQty: opts.requestedSellQty,
    })
  ) {
    return {
      ok: false,
      reason: `total executable SELL (${effectiveResting + opts.requestedSellQty}) would exceed reconciled held qty (${opts.reconciledHeldQty})`,
    };
  }
  return { ok: true };
}
