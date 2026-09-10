// Manual Trade Guardian Stage 1 pure decision core. This module intentionally
// has no database, quote, or broker imports: tests can prove that arming a plan
// is not itself an order action.

export type GuardianPlanStatus =
  | "pending_approval" | "armed" | "triggering" | "trigger_submitted"
  | "trigger_needs_reconcile" | "declined" | "cancelled" | "invalidated";

export interface GuardianProtectionPlan {
  id: number;
  symbol: string;
  qty: number;
  stopPrice: number;
  status: GuardianPlanStatus;
}

export type GuardianEvaluation =
  | { action: "skip"; reason: "not_armed" | "invalid_quote" | "above_stop" }
  | { action: "trigger"; reason: "stop_breached" };

/** A Guardian plan may trigger only after the owner armed it and a positive,
 * fresh price is at or below the pre-committed stop. Equal is a breach. */
export function evaluateGuardianProtection(
  plan: GuardianProtectionPlan,
  currentPrice: number | null | undefined,
): GuardianEvaluation {
  if (plan.status !== "armed") return { action: "skip", reason: "not_armed" };
  if (!Number.isFinite(currentPrice) || (currentPrice ?? 0) <= 0) {
    return { action: "skip", reason: "invalid_quote" };
  }
  if ((currentPrice as number) <= plan.stopPrice) return { action: "trigger", reason: "stop_breached" };
  return { action: "skip", reason: "above_stop" };
}
