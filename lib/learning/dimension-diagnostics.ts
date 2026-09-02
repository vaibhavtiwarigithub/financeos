import crypto from "node:crypto";
import { computeSpearmanIC } from "@/lib/validation/feature-check";
import { ALL_SCORED_COHORT_KEY, ENTRY_COHORT_KEY, isEligibleLong } from "./entry-cohort";

// v3 adds forward-written decision code versions. v1/v2 remain immutable in
// production rather than being reinterpreted after the fact.
//
// v4 moves every predictive headline onto the eligible-long cohort (see
// ./entry-cohort.ts). This CHANGES WHAT THE NUMBER MEANS, so it gets a new plan
// version rather than silently redefining v3's series: a v3 mean_session_rank_ic
// and a v4 one are not comparable, and the frozen-history rule forbids
// reinterpreting the recorded v3 rows after the fact.
// v5 (2026-08-28, hours after v4): the loader was silently truncated to
// PostgREST's 1,000-row server maximum, so v4's US runs saw ~40% of the rows and
// half the dates. That is a different dataset, not a refinement of the same one,
// so v4 rows are kept as recorded and superseded rather than deleted or rerun in
// place. India was under the cap and its v4 numbers are unaffected.
export const DIMENSION_DIAGNOSTIC_PLAN_VERSION = "dimension_diagnostics_p0_v5";
// 2/5/10/20 rank signal quality at or near the mandate holding period (5-15
// sessions). 60/120 measure EXIT TIMING — "are we exiting too early" — which
// the short labels structurally cannot answer, because a 20-day label can never
// observe what a position would have done after the mandate closed it.
// label-maturation has written these since 2026-08-17; first h60 rows mature
// ~2026-09-29.
export const DIAGNOSTIC_HORIZONS = [2, 5, 10, 20, 60, 120] as const;
export const DIAGNOSTIC_DIMENSIONS = [
  "fundamental", "technical", "sentiment", "macro", "insider",
] as const;
export const MIN_PREDICTIVE_DATES = 20;
export const MIN_CROSS_SECTION = 5;

/**
 * Independent-observation floor, applied ON TOP of MIN_PREDICTIVE_DATES.
 *
 * Counting decision dates is horizon-blind, and that blindness is dangerous in
 * exactly the direction that produces false confidence. Forward windows of
 * length `horizonDays` starting on consecutive dates overlap almost entirely,
 * so N dates are nowhere near N independent draws. The standard overlap
 * correction is nEffective = n / horizonDays:
 *
 *   h10,  20 dates -> nEffective 2.0
 *   h20,  20 dates -> nEffective 1.0
 *   h120, 20 dates -> nEffective 0.17   (ONE independent observation)
 *
 * Without this, widening DIAGNOSTIC_HORIZONS to 60/120 would let the 20-date
 * gate pass and emit a `measured_descriptive` predictive finding built on
 * essentially a single non-overlapping window. A long horizon needs
 * proportionally MORE dates, not the same number.
 */
export const MIN_EFFECTIVE_OBSERVATIONS = 12;

export function effectiveObservations(qualifyingSessions: number, horizonDays: number): number {
  if (!Number.isFinite(horizonDays) || horizonDays <= 0) return 0;
  return qualifyingSessions / horizonDays;
}

export type DiagnosticDimension = (typeof DIAGNOSTIC_DIMENSIONS)[number];
export type DiagnosticFinding = {
  subjectType: "dimension" | "agent" | "collaboration";
  subjectKey: string;
  findingType: "availability" | "predictive" | "contribution" | "collaboration";
  classification: string;
  metrics: Record<string, unknown>;
  reason: string;
};

export type DiagnosticObservation = {
  id: number;
  ts: string;
  symbol: string;
  codeVersion: string | null;
  analystScore: number | null;
  scores: Record<DiagnosticDimension, number | null>;
  availabilityMask: Partial<Record<DiagnosticDimension, boolean>> | null;
  benchmarkNeutralReturn: number | null;
  entryEligible: boolean;
  /** Decision direction. Required for the cohort predicate; see ./entry-cohort.ts. */
  direction: string | null;
  action: string;
  agentLabel: string;
};

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function hitRate(values: number[]): number | null {
  return values.length ? values.filter((value) => value > 0).length / values.length : null;
}

/** Sample standard deviation (n-1). Null below two sessions, where spread is undefined. */
function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values)!;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * How many standard errors the mean session IC sits from zero.
 *
 * The standard error uses nEFFECTIVE, not the session count. Sessions overlap:
 * `horizonDays` consecutive sessions measure almost the same market move, so
 * dividing by sqrt(sessions) would understate the error by a factor of
 * sqrt(horizonDays) — at h20 that inflates |t| by ~4.5x and manufactures
 * significance out of overlap. See MIN_EFFECTIVE_OBSERVATIONS.
 *
 * Null when spread is undefined (<2 sessions) or degenerate (sd 0), rather than
 * returning Infinity, which would render as a spuriously decisive result.
 */
export function tStatistic(meanIc: number | null, sd: number | null, nEffective: number): number | null {
  if (meanIc == null || sd == null || !Number.isFinite(sd) || sd <= 0) return null;
  if (!Number.isFinite(nEffective) || nEffective <= 0) return null;
  return meanIc / (sd / Math.sqrt(nEffective));
}

function dateOf(ts: string): string {
  return ts.slice(0, 10);
}

function predictiveMetrics(rows: Array<{ value: number; outcome: number; ts: string }>, horizonDays: number) {
  const byDate = new Map<string, Array<{ value: number; outcome: number }>>();
  for (const row of rows) {
    const date = dateOf(row.ts);
    const values = byDate.get(date) ?? [];
    values.push({ value: row.value, outcome: row.outcome });
    byDate.set(date, values);
  }
  // The per-session series is the ONLY object here that is a genuine time
  // series. `mean_session_rank_ic` is an EXPANDING-window average over every
  // session to date, so plotting it across daily runs charts a cumulative mean
  // converging, not a signal changing — consecutive runs share ~93% of their
  // input. These per-session points are one trading day each and are what a
  // "how has IC moved" chart must be drawn from.
  const sessions: Array<{ date: string; ic: number; cross_section: number }> = [];
  for (const [date, values] of byDate) {
    if (values.length < MIN_CROSS_SECTION) continue;
    const result = computeSpearmanIC(values.map((value) => value.value), values.map((value) => value.outcome));
    if (!result || !Number.isFinite(result.ic)) continue;
    sessions.push({ date, ic: result.ic, cross_section: values.length });
  }
  // Row order follows the paginated id order, not the calendar. Sort so the
  // series is chronological for any consumer that plots it as-is.
  sessions.sort((left, right) => left.date.localeCompare(right.date));
  const sessionIcs = sessions.map((session) => session.ic);
  const qualifyingSessions = sessions.length;
  const avgIc = mean(sessionIcs);
  const sdIc = sampleStdDev(sessionIcs);
  // BOTH floors must clear. Dates alone are horizon-blind; nEffective alone
  // would admit a horizon so short that overlap is irrelevant but the sample is
  // still tiny.
  const nEffective = effectiveObservations(qualifyingSessions, horizonDays);
  const datesShort = qualifyingSessions < MIN_PREDICTIVE_DATES;
  const overlapShort = nEffective < MIN_EFFECTIVE_OBSERVATIONS;
  const classification = datesShort || overlapShort
    ? "insufficient_evidence"
    : "measured_descriptive";
  return {
    classification,
    metrics: {
      labeled_observations: rows.length,
      distinct_sessions: byDate.size,
      qualifying_sessions: qualifyingSessions,
      min_sessions_required: MIN_PREDICTIVE_DATES,
      min_cross_section_required: MIN_CROSS_SECTION,
      horizon_days: horizonDays,
      effective_observations: nEffective,
      min_effective_observations_required: MIN_EFFECTIVE_OBSERVATIONS,
      mean_session_rank_ic: avgIc,
      sd_session_rank_ic: sdIc,
      t_stat: tStatistic(avgIc, sdIc, nEffective),
      positive_session_share: hitRate(sessionIcs),
    },
    sessions,
    reason: datesShort
      ? `Only ${qualifyingSessions}/${MIN_PREDICTIVE_DATES} sessions have a cross-section of at least ${MIN_CROSS_SECTION}; no predictive conclusion is permitted.`
      : overlapShort
        ? `${qualifyingSessions} sessions at a ${horizonDays}-day horizon overlap to only ${nEffective.toFixed(2)} independent observations (need ${MIN_EFFECTIVE_OBSERVATIONS}); no predictive conclusion is permitted.`
        : "Descriptive session-level rank IC only. This is not validation, a promotion result, or a change recommendation.",
  };
}

export function buildDimensionFindings(observations: DiagnosticObservation[], horizonDays: number): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const dimension of DIAGNOSTIC_DIMENSIONS) {
    const available = observations.filter((row) => row.availabilityMask?.[dimension] === true);
    const unavailable = observations.filter((row) => row.availabilityMask?.[dimension] === false);
    const unknown = observations.length - available.length - unavailable.length;
    findings.push({
      subjectType: "dimension",
      subjectKey: dimension,
      findingType: "availability",
      classification: available.length === 0 ? "data_degraded" : "measured_descriptive",
      metrics: {
        observations: observations.length,
        available: available.length,
        unavailable: unavailable.length,
        unknown,
        availability_rate: observations.length ? available.length / observations.length : null,
      },
      reason: available.length === 0
        ? `No labeled observations declared ${dimension} available. This is a data-quality finding, not a scoring recommendation.`
        : "Availability is measured from the immutable decision-time mask; it is not re-fetched from current providers.",
    });

    const toRows = (source: DiagnosticObservation[]) => source.flatMap((row) => {
      const value = finite(row.scores[dimension]);
      const outcome = finite(row.benchmarkNeutralReturn);
      return value == null || outcome == null ? [] : [{ value, outcome, ts: row.ts }];
    });
    // HEADLINE = the cohort that can actually be entered. The all-scored number
    // ranks names the system would never buy, which is how a +0.105 "edge" was
    // published and retracted; it survives only as labelled context.
    const eligible = available.filter((row) => isEligibleLong(row.entryEligible, row.direction));
    const predictive = predictiveMetrics(toRows(eligible), horizonDays);
    const context = predictiveMetrics(toRows(available), horizonDays);
    findings.push({
      subjectType: "dimension",
      subjectKey: dimension,
      findingType: "predictive",
      classification: predictive.classification,
      metrics: {
        cohort: ENTRY_COHORT_KEY,
        ...predictive.metrics,
        // Headline cohort ONLY. The context cohort keeps its summary stats but
        // no series: carrying both would double the stored payload to plot a
        // line nobody may cite as predictive power.
        session_ic_series: predictive.sessions,
        [`${ALL_SCORED_COHORT_KEY}_context`]: {
          cohort: ALL_SCORED_COHORT_KEY,
          ...context.metrics,
          interpretation: "Context only. Includes observations that were never entry eligible and could not have been bought; never cite this as the score's predictive power.",
        },
      },
      reason: predictive.reason,
    });
  }
  return findings;
}

export function buildAgentFindings(observations: DiagnosticObservation[], horizonDays: number): DiagnosticFinding[] {
  const byAgent = new Map<string, DiagnosticObservation[]>();
  for (const observation of observations) {
    const key = `${observation.agentLabel || "research:unlabeled"}@${observation.codeVersion ?? "unknown-code"}`;
    const rows = byAgent.get(key) ?? [];
    rows.push(observation);
    byAgent.set(key, rows);
  }

  const findings: DiagnosticFinding[] = [];
  for (const [agent, rows] of byAgent) {
    const toRows = (source: DiagnosticObservation[]) => source.flatMap((row) => {
      const score = finite(row.analystScore);
      const outcome = finite(row.benchmarkNeutralReturn);
      return score == null || outcome == null ? [] : [{ value: score, outcome, ts: row.ts }];
    });
    const eligibleRows = rows.filter((row) => isEligibleLong(row.entryEligible, row.direction));
    const predictive = predictiveMetrics(toRows(eligibleRows), horizonDays);
    const context = predictiveMetrics(toRows(rows), horizonDays);
    const eligibleReturns = eligibleRows.flatMap((row) => finite(row.benchmarkNeutralReturn) != null
      ? [finite(row.benchmarkNeutralReturn)!] : []);
    const availabilityValues = rows.flatMap((row) => DIAGNOSTIC_DIMENSIONS.map((dimension) => row.availabilityMask?.[dimension] === true ? 1 : 0));
    const versionedObservations = rows.filter((row) => row.codeVersion != null).length;
    const hasCompleteVersionProvenance = versionedObservations === rows.length;
    const classification = !hasCompleteVersionProvenance
      ? "data_degraded"
      : predictive.classification;
    findings.push({
      subjectType: "agent",
      subjectKey: agent,
      findingType: "contribution",
      classification,
      metrics: {
        cohort: ENTRY_COHORT_KEY,
        ...predictive.metrics,
        [`${ALL_SCORED_COHORT_KEY}_context`]: {
          cohort: ALL_SCORED_COHORT_KEY,
          ...context.metrics,
          interpretation: "Context only. Includes observations that were never entry eligible and could not have been bought.",
        },
        observations: rows.length,
        eligible_observations: eligibleRows.length,
        code_versioned_observations: versionedObservations,
        code_version_coverage: rows.length ? versionedObservations / rows.length : null,
        eligible_decisions: eligibleRows.length,
        signal_written: rows.filter((row) => row.action === "signal_written").length,
        eligible_mean_benchmark_neutral_return: mean(eligibleReturns),
        eligible_positive_return_share: hitRate(eligibleReturns),
        dimension_availability_rate: mean(availabilityValues),
      },
      reason: !hasCompleteVersionProvenance
        ? "Agent contribution is not rated: one or more decision records lack a code version, so behavior cannot be compared safely across deployments."
        : predictive.classification === "insufficient_evidence"
        ? "Agent contribution is not rated: the mature, market-local session sample is below the predeclared floor."
        : "Agent contribution is descriptive only and cannot reward, punish, disable, or reconfigure an agent.",
    });
  }
  findings.push({
    subjectType: "collaboration",
    subjectKey: "workflow_combination",
    findingType: "collaboration",
    classification: "unattributable_no_paired_shadow",
    metrics: { observations: observations.length, paired_shadow_observations: 0 },
    reason: "Several agents appearing in one workflow is not causal evidence. A collaboration claim requires paired, market-local shadow decisions with and without a declared input.",
  });
  return findings;
}

export function diagnosticFingerprint(market: string, horizonDays: number, observations: DiagnosticObservation[]): string {
  const material = observations
    .map((row) => `${row.id}:${row.ts}:${row.symbol}:${row.agentLabel}:${row.codeVersion}:${row.benchmarkNeutralReturn}:${isEligibleLong(row.entryEligible, row.direction) ? 1 : 0}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(`${DIMENSION_DIAGNOSTIC_PLAN_VERSION}|${market}|${horizonDays}|${material}`).digest("hex");
}
