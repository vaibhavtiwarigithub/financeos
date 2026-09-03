// Time-review exit shadow — pure policy and outcome math.
// Measure-only. No function in this file can mutate a position or place an order.

import type { LabelCandle } from "@/lib/learning/label-window";

export const TIME_REVIEW_POLICY_VERSION = "time-review-v1";
export const TIME_REVIEW_EXTENSIONS = [5, 10] as const;

export type TimeReviewFailure =
  | "not_exact_horizon"
  | "invalid_entry_price"
  | "invalid_review_price"
  | "not_profitable"
  | "score_missing"
  | "score_stale"
  | "score_below_hold_threshold"
  | "direction_not_long"
  | "high_water_missing"
  | "stop_distance_missing"
  | "drawdown_exceeds_stop_distance"
  | "mechanical_stop_due"
  | "target_due";

export interface TimeReviewInputs {
  ageDays: number;
  horizonDays: number;
  entryPrice: number | null;
  reviewPrice: number | null;
  highWaterPrice: number | null;
  initialStopPrice: number | null;
  effectiveStopPrice: number | null;
  targetPrice: number | null;
  score: number | null;
  scoreFresh: boolean;
  scoreDirection: string | null;
  holdThreshold: number;
}

export interface TimeReviewClassification {
  eligible: boolean;
  classification: "eligible" | "not_eligible";
  failed: TimeReviewFailure[];
  unrealizedReturnPct: number | null;
  drawdownFromHighPct: number | null;
  initialStopDistancePct: number | null;
}

function positive(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function classifyTimeReview(input: TimeReviewInputs): TimeReviewClassification {
  const failed: TimeReviewFailure[] = [];
  if (input.ageDays !== input.horizonDays) failed.push("not_exact_horizon");
  if (!positive(input.entryPrice)) failed.push("invalid_entry_price");
  if (!positive(input.reviewPrice)) failed.push("invalid_review_price");

  const unrealizedReturnPct = positive(input.entryPrice) && positive(input.reviewPrice)
    ? ((input.reviewPrice - input.entryPrice) / input.entryPrice) * 100
    : null;
  if (unrealizedReturnPct == null || unrealizedReturnPct <= 0) failed.push("not_profitable");

  if (input.score == null || !Number.isFinite(input.score)) failed.push("score_missing");
  else if (!input.scoreFresh) failed.push("score_stale");
  else if (input.score < input.holdThreshold) failed.push("score_below_hold_threshold");
  if (input.scoreDirection !== "long") failed.push("direction_not_long");

  const high = positive(input.highWaterPrice) && positive(input.reviewPrice)
    ? Math.max(input.highWaterPrice, input.reviewPrice)
    : null;
  const drawdownFromHighPct = high != null && positive(input.reviewPrice)
    ? ((high - input.reviewPrice) / high) * 100
    : null;
  if (drawdownFromHighPct == null) failed.push("high_water_missing");

  const initialStopDistancePct = positive(input.entryPrice) && positive(input.initialStopPrice)
    && input.initialStopPrice <= input.entryPrice
    ? ((input.entryPrice - input.initialStopPrice) / input.entryPrice) * 100
    : null;
  if (initialStopDistancePct == null) failed.push("stop_distance_missing");
  else if (drawdownFromHighPct != null && drawdownFromHighPct > initialStopDistancePct) {
    failed.push("drawdown_exceeds_stop_distance");
  }
  if (positive(input.reviewPrice) && positive(input.effectiveStopPrice)
      && input.reviewPrice <= input.effectiveStopPrice) failed.push("mechanical_stop_due");
  if (positive(input.reviewPrice) && positive(input.targetPrice)
      && input.reviewPrice >= input.targetPrice) failed.push("target_due");

  const unique = [...new Set(failed)];
  return {
    eligible: unique.length === 0,
    classification: unique.length === 0 ? "eligible" : "not_eligible",
    failed: unique,
    unrealizedReturnPct,
    drawdownFromHighPct,
    initialStopDistancePct,
  };
}

export function timeReviewIdempotencyKey(input: {
  market: "us" | "india";
  positionId: string;
  reviewSession: string;
}): string {
  return `${TIME_REVIEW_POLICY_VERSION}:${input.market}:${input.positionId}:${input.reviewSession}`;
}

export interface TimeReviewOutcome {
  baselineExitSession: string;
  baselineExitPrice: number;
  baselineTotalReturnPct: number;
  baselineReviewReturnPct: number;
  candidateExitSession: string;
  candidateExitPrice: number;
  candidateTotalReturnPct: number;
  candidateReviewReturnPct: number;
  incrementalVsBaselinePct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  mechanicalStopHit: boolean;
  mechanicalStopSession: string | null;
}

/**
 * Compare the incumbent next-session close with a bounded +5/+10-session hold.
 * The candidate retains the effective stop frozen at review and exits there on
 * the first low that breaches it. Gap/slippage modelling belongs to the later
 * execution-faithful portfolio simulation, not this descriptive P1 label.
 */
export function computeTimeReviewOutcome(input: {
  entryPrice: number;
  reviewPrice: number;
  effectiveStopPrice: number | null;
  forward: LabelCandle[];
  extensionDays: 5 | 10;
}): TimeReviewOutcome | null {
  const { entryPrice, reviewPrice, effectiveStopPrice, forward, extensionDays } = input;
  if (!positive(entryPrice) || !positive(reviewPrice) || forward.length < extensionDays) return null;
  const window = forward.slice(0, extensionDays);
  const baseline = window[0];
  if (!baseline || !positive(baseline.close)) return null;

  let exit = window[window.length - 1];
  let stopSession: string | null = null;
  if (positive(effectiveStopPrice)) {
    const stopBar = window.find((bar) => Number.isFinite(bar.low) && bar.low <= effectiveStopPrice);
    if (stopBar) {
      exit = { ...stopBar, close: effectiveStopPrice };
      stopSession = stopBar.date;
    }
  }
  if (!exit || !positive(exit.close)) return null;

  const observed = stopSession == null
    ? window
    : window.slice(0, window.findIndex((bar) => bar.date === stopSession) + 1);
  const maxHigh = Math.max(...observed.map((bar) => Number(bar.high)));
  const minLow = Math.min(...observed.map((bar) => Number(bar.low)));
  if (!Number.isFinite(maxHigh) || !Number.isFinite(minLow)) return null;

  const pct = (end: number, start: number) => ((end - start) / start) * 100;
  const baselineTotal = pct(baseline.close, entryPrice);
  const candidateTotal = pct(exit.close, entryPrice);
  return {
    baselineExitSession: baseline.date,
    baselineExitPrice: baseline.close,
    baselineTotalReturnPct: baselineTotal,
    baselineReviewReturnPct: pct(baseline.close, reviewPrice),
    candidateExitSession: exit.date,
    candidateExitPrice: exit.close,
    candidateTotalReturnPct: candidateTotal,
    candidateReviewReturnPct: pct(exit.close, reviewPrice),
    incrementalVsBaselinePct: candidateTotal - baselineTotal,
    maxFavorableExcursionPct: pct(maxHigh, reviewPrice),
    maxAdverseExcursionPct: pct(minLow, reviewPrice),
    mechanicalStopHit: stopSession != null,
    mechanicalStopSession: stopSession,
  };
}
