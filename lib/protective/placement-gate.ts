// Hybrid protective stops — PLACEMENT GATE (shadow scaffold).
//
// THIS IS THE MONEY LINE. The whole feature is built UP TO here and STOPS.
// No real broker order is ever placed by this scaffold. Not a $1 test. Ever.
//
// A false-by-default flag (`protective_orders_enabled`) gates ALL placement and
// stays false. `planProtectivePlacement()` produces the INTENDED broker action as
// a plain object — it NEVER calls a broker. A future, owner-approved live path
// would be the only thing allowed to act on a plan, and only after this gate
// returns allowed AND Q1 (touch semantics), the floor distance, and the post-fill
// protection policy are approved.
//
// Deterministic. NO LLM computes, places, modifies, or cancels protection.

import { ProtectionEligibility, ProtectiveOrderKind } from "@/lib/protective/capabilities";
import { DisasterFloorResult } from "@/lib/protective/disaster-floor";
import { canSubmitCompetingSell } from "@/lib/protective/state";

// The config flag column name (strategy_config.protective_orders_enabled).
export const PROTECTIVE_ORDERS_FLAG = "protective_orders_enabled";

export interface ProtectiveFlagConfig {
  protective_orders_enabled?: boolean | null;
}

// STRICT: only an explicit `true` enables. null / undefined / anything else stays
// disabled. There is no environment override and no default-on path.
export function protectivePlacementAllowed(cfg: ProtectiveFlagConfig | null | undefined): boolean {
  return cfg?.protective_orders_enabled === true;
}

export type ProtectivePlanAction = "place_floor" | "ratchet_up" | "replace_after_cancel" | "none";

export interface ProtectivePlacementPlan {
  /** Whether a live path would be PERMITTED to act — false while the flag is false. */
  allowed: boolean;
  action: ProtectivePlanAction;
  /** Human-readable, honest description of what WOULD happen (shadow only). */
  intent: string;
  /** Blocking reasons — the plan is inert until every one is cleared. */
  blockedBy: string[];
  /** The shadow-computed broker parameters (never sent anywhere). */
  shadow: {
    symbol: string;
    market: "us" | "india";
    brokerAccountId: string;
    orderKind: ProtectiveOrderKind;
    triggerPrice: number | null;
    limitPrice: number | null;
    qty: number;
  } | null;
}

export interface PlanProtectivePlacementInput {
  flag: ProtectiveFlagConfig | null | undefined;
  symbol: string;
  market: "us" | "india";
  brokerAccountId: string;
  eligibility: ProtectionEligibility;
  floor: DisasterFloorResult;
  action: ProtectivePlanAction;
  reconciledHeldQty: number;
  desiredProtectQty: number;
  /** For a replace-after-cancel: whether the resting order's cancel is confirmed. */
  restingProtectiveQty?: number;
  restingCancellationConfirmed?: boolean;
}

// Produce the placement PLAN. Never places. `allowed` is false while the flag is
// false — so the returned plan is always inert in this scaffold.
export function planProtectivePlacement(input: PlanProtectivePlacementInput): ProtectivePlacementPlan {
  const blockedBy: string[] = [];

  // 1) The money-line flag. False by default → everything downstream is inert.
  if (!protectivePlacementAllowed(input.flag)) {
    blockedBy.push(`${PROTECTIVE_ORDERS_FLAG} is false — placement disabled (shadow scaffold; no broker order is ever placed)`);
  }

  // 2) Broker must actually be able to protect this position.
  if (!input.eligibility.protectedByBroker) {
    blockedBy.push(`unprotected-by-broker: ${input.eligibility.reason}`);
  }

  // 3) Floor must be valid.
  if (!input.floor.ok || input.floor.floor == null) {
    blockedBy.push(`invalid disaster floor: ${input.floor.reason}`);
  }

  // 4) Long-only: protected qty can never exceed reconciled held qty, and a
  //    replace requires a CONFIRMED cancellation of the resting order first.
  const qty = Math.max(0, Math.floor(input.desiredProtectQty));
  if (qty <= 0) {
    blockedBy.push("desired protect qty rounds to zero");
  } else if (qty > input.reconciledHeldQty) {
    blockedBy.push(`protect qty ${qty} exceeds reconciled held qty ${input.reconciledHeldQty} (long-only)`);
  }
  if (input.action === "replace_after_cancel") {
    const sell = canSubmitCompetingSell({
      reconciledHeldQty: input.reconciledHeldQty,
      restingProtectiveQty: input.restingProtectiveQty ?? 0,
      restingCancellationConfirmed: input.restingCancellationConfirmed ?? false,
      requestedSellQty: qty,
    });
    if (!sell.ok) blockedBy.push(`replace blocked: ${sell.reason}`);
  }

  const eligible = input.eligibility.protectedByBroker ? input.eligibility : null;
  const shadow = eligible
    ? {
        symbol: input.symbol,
        market: input.market,
        brokerAccountId: input.brokerAccountId,
        orderKind: eligible.kind,
        triggerPrice: input.floor.floor,
        // A limit child (gtt_limit/stop_limit) sets a limit; a stop-market has none.
        limitPrice: eligible.strength === "weaker_limit" ? input.floor.floor : null,
        qty,
      }
    : null;

  const allowed = blockedBy.length === 0;
  return {
    allowed,
    action: allowed ? input.action : "none",
    intent: allowed
      ? `WOULD ${input.action} a ${eligible?.kind} floor for ${qty} ${input.symbol} @ ${input.floor.floor} — but this scaffold never sends it`
      : `inert plan (${blockedBy.length} blocker(s)) — no broker action`,
    blockedBy,
    shadow,
  };
}
