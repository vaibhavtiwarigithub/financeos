export type PaperTopUpRejection =
  | "top_up_invalid_weighted_cost"
  | "top_up_not_above_weighted_cost"
  | "top_up_at_or_below_active_stop"
  | "top_up_at_or_above_active_target"
  | "top_up_already_filled_this_session";

export type PaperTopUpAssessment =
  | { allowed: true; activeStop: number | null; activeTarget: number | null }
  | { allowed: false; reason: PaperTopUpRejection };

/** Shared US/India paper-only add-to-winner policy. It never sizes an order. */
export function assessPaperTopUp(input: {
  fillPrice: number;
  weightedAverageCost: number;
  activeStop?: number | null;
  activeTarget?: number | null;
  fillsThisSession?: number;
}): PaperTopUpAssessment {
  const { fillPrice, weightedAverageCost } = input;
  if (!Number.isFinite(fillPrice) || fillPrice <= 0
    || !Number.isFinite(weightedAverageCost) || weightedAverageCost <= 0) {
    return { allowed: false, reason: "top_up_invalid_weighted_cost" };
  }
  if (fillPrice <= weightedAverageCost) {
    return { allowed: false, reason: "top_up_not_above_weighted_cost" };
  }
  const activeStop = Number.isFinite(input.activeStop) && Number(input.activeStop) > 0
    ? Number(input.activeStop)
    : null;
  const activeTarget = Number.isFinite(input.activeTarget) && Number(input.activeTarget) > 0
    ? Number(input.activeTarget)
    : null;
  if (activeStop != null && fillPrice <= activeStop) {
    return { allowed: false, reason: "top_up_at_or_below_active_stop" };
  }
  if (activeTarget != null && fillPrice >= activeTarget) {
    return { allowed: false, reason: "top_up_at_or_above_active_target" };
  }
  if ((input.fillsThisSession ?? 0) > 0) {
    return { allowed: false, reason: "top_up_already_filled_this_session" };
  }
  return { allowed: true, activeStop, activeTarget };
}
