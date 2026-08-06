import crypto from "node:crypto";
import { computeSpearmanIC } from "@/lib/validation/feature-check";

// v3 adds forward-written decision code versions. v1/v2 remain immutable in
// production rather than being reinterpreted after the fact.
export const DIMENSION_DIAGNOSTIC_PLAN_VERSION = "dimension_diagnostics_p0_v3";
export const DIAGNOSTIC_HORIZONS = [2, 5, 10, 20] as const;
export const DIAGNOSTIC_DIMENSIONS = [
  "fundamental", "technical", "sentiment", "macro", "insider",
] as const;
export const MIN_PREDICTIVE_DATES = 20;
export const MIN_CROSS_SECTION = 5;

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

function dateOf(ts: string): string {
  return ts.slice(0, 10);
}

function predictiveMetrics(rows: Array<{ value: number; outcome: number; ts: string }>) {
  const byDate = new Map<string, Array<{ value: number; outcome: number }>>();
  for (const row of rows) {
    const date = dateOf(row.ts);
    const values = byDate.get(date) ?? [];
    values.push({ value: row.value, outcome: row.outcome });
    byDate.set(date, values);
  }
  const sessionIcs: number[] = [];
  let qualifyingSessions = 0;
  for (const values of byDate.values()) {
    if (values.length < MIN_CROSS_SECTION) continue;
    const result = computeSpearmanIC(values.map((value) => value.value), values.map((value) => value.outcome));
    if (!result || !Number.isFinite(result.ic)) continue;
    qualifyingSessions++;
    sessionIcs.push(result.ic);
  }
  const avgIc = mean(sessionIcs);
  const classification = qualifyingSessions < MIN_PREDICTIVE_DATES
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
      mean_session_rank_ic: avgIc,
      positive_session_share: hitRate(sessionIcs),
    },
    reason: classification === "insufficient_evidence"
      ? `Only ${qualifyingSessions}/${MIN_PREDICTIVE_DATES} sessions have a cross-section of at least ${MIN_CROSS_SECTION}; no predictive conclusion is permitted.`
      : "Descriptive session-level rank IC only. This is not validation, a promotion result, or a change recommendation.",
  };
}

export function buildDimensionFindings(observations: DiagnosticObservation[]): DiagnosticFinding[] {
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

    const predictiveRows = available.flatMap((row) => {
      const value = finite(row.scores[dimension]);
      const outcome = finite(row.benchmarkNeutralReturn);
      return value == null || outcome == null ? [] : [{ value, outcome, ts: row.ts }];
    });
    const predictive = predictiveMetrics(predictiveRows);
    findings.push({
      subjectType: "dimension",
      subjectKey: dimension,
      findingType: "predictive",
      classification: predictive.classification,
      metrics: predictive.metrics,
      reason: predictive.reason,
    });
  }
  return findings;
}

export function buildAgentFindings(observations: DiagnosticObservation[]): DiagnosticFinding[] {
  const byAgent = new Map<string, DiagnosticObservation[]>();
  for (const observation of observations) {
    const key = `${observation.agentLabel || "research:unlabeled"}@${observation.codeVersion ?? "unknown-code"}`;
    const rows = byAgent.get(key) ?? [];
    rows.push(observation);
    byAgent.set(key, rows);
  }

  const findings: DiagnosticFinding[] = [];
  for (const [agent, rows] of byAgent) {
    const outcomeRows = rows.flatMap((row) => {
      const score = finite(row.analystScore);
      const outcome = finite(row.benchmarkNeutralReturn);
      return score == null || outcome == null ? [] : [{ value: score, outcome, ts: row.ts }];
    });
    const predictive = predictiveMetrics(outcomeRows);
    const eligibleReturns = rows.flatMap((row) => row.entryEligible && finite(row.benchmarkNeutralReturn) != null
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
        ...predictive.metrics,
        observations: rows.length,
        code_versioned_observations: versionedObservations,
        code_version_coverage: rows.length ? versionedObservations / rows.length : null,
        eligible_decisions: rows.filter((row) => row.entryEligible).length,
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
    .map((row) => `${row.id}:${row.ts}:${row.symbol}:${row.agentLabel}:${row.codeVersion}:${row.benchmarkNeutralReturn}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(`${DIMENSION_DIAGNOSTIC_PLAN_VERSION}|${market}|${horizonDays}|${material}`).digest("hex");
}
