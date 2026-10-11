import { resolveDecisionContext } from "@/lib/learning/entry-cohort";

/** Predeclared score-boundary sample for the council's missed-entry question. */
export const COUNCIL_COHORT_KEY = "near_threshold_entry_long_v1";
export const COUNCIL_COHORT_HALF_WIDTH = 5;

export type NearThresholdObservation = {
  analyst_score: unknown;
  score_threshold: unknown;
  direction: unknown;
  decision_context?: unknown;
  discovery_source?: unknown;
};

function numeric(value: unknown): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Includes eligible and ineligible LONG entry candidates within five points
 * of the recorded deterministic threshold. Holding reviews and unknown
 * decision contexts are excluded. Eligibility itself is deliberately not a
 * filter: the experiment asks whether the council can help at the gate.
 */
export function isNearThresholdEntryLong(
  observation: NearThresholdObservation,
  halfWidth = COUNCIL_COHORT_HALF_WIDTH,
): boolean {
  const score = numeric(observation.analyst_score);
  const threshold = numeric(observation.score_threshold);
  return score != null
    && threshold != null
    && Number.isFinite(halfWidth)
    && halfWidth >= 0
    && observation.direction === "long"
    && resolveDecisionContext(observation.decision_context, observation.discovery_source) === "entry_candidate"
    && Math.abs(score - threshold) <= halfWidth;
}

export function thresholdDistance(observation: NearThresholdObservation): number {
  const score = numeric(observation.analyst_score);
  const threshold = numeric(observation.score_threshold);
  return score == null || threshold == null ? Number.POSITIVE_INFINITY : Math.abs(score - threshold);
}
