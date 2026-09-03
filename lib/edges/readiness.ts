import type { Market } from "@/lib/edges/types";

export const EDGE_READINESS_POLICY_VERSION = "edge-readiness.v2-horizon-spaced";
export const HISTORICAL_WINDOWS_REQUIRED = 6;
export const VALIDATION_WINDOWS_REQUIRED = 4;
export const MIN_OBSERVATIONS_PER_WINDOW = 72;
export const VALIDATION_EVIDENCE_QUALITY = "pit_walk_forward_cost_adjusted_fdr";

/**
 * Approximate a forward-return horizon in trading sessions with a conservative
 * calendar-day spacing. This is the readiness-ledger counterpart to
 * folds.ts refusing stepSessions < horizonSessions: two windows whose labels
 * overlap are not independent evidence merely because their runs were weekly.
 */
export function independentWindowDays(horizonSessions: number): number {
  if (!Number.isFinite(horizonSessions) || horizonSessions < 1) {
    throw new Error("edge readiness horizon must be a positive session count");
  }
  return Math.ceil(horizonSessions * 7 / 5);
}

export type EdgeReadinessStage =
  | "collecting"
  | "needs_stability"
  | "ready_for_validation_build"
  | "ready_for_shadow_review";

export interface EdgeReadinessInput {
  edgeId: string;
  market: Market;
  horizon: number;
  windowEnd: string;
  createdAt: string;
  segmentType: string;
  segmentValue: string;
  ic: number | string | null;
  tStat: number | string | null;
  nObs: number | string | null;
  evidenceQuality: string | null;
  netOfFeeIc: number | string | null;
  turnover: number | string | null;
}

export interface EdgeReadinessResult {
  edgeId: string;
  market: Market;
  horizon: number;
  policyVersion: string;
  stage: EdgeReadinessStage;
  windowsObserved: number;
  windowsRequired: number;
  positiveWindows: number;
  medianIc: number | null;
  medianTStat: number | null;
  minNObs: number | null;
  latestWindowEnd: string | null;
  validationWindowsObserved: number;
  validationWindowsRequired: number;
  positiveValidationWindows: number;
  medianNetOfFeeIc: number | null;
  nextAction: string;
  gates: Record<string, boolean | number | string | null>;
}

function finite(value: number | string | null): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dayNumber(value: string): number | null {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) ? Math.floor(time / 86_400_000) : null;
}

/** Latest provider revision per window, then newest independent windows. */
export function selectIndependentWindows(rows: EdgeReadinessInput[], limit: number): EdgeReadinessInput[] {
  const latestByWindow = new Map<string, EdgeReadinessInput>();
  for (const row of rows) {
    if (row.segmentType !== "market" || row.segmentValue !== "all" || dayNumber(row.windowEnd) == null) continue;
    const current = latestByWindow.get(row.windowEnd);
    if (!current || Date.parse(row.createdAt) > Date.parse(current.createdAt)) latestByWindow.set(row.windowEnd, row);
  }
  const candidates = [...latestByWindow.values()].sort((a, b) => b.windowEnd.localeCompare(a.windowEnd));
  const selected: EdgeReadinessInput[] = [];
  let lastDay: number | null = null;
  for (const row of candidates) {
    const day = dayNumber(row.windowEnd)!;
    if (lastDay != null && lastDay - day < independentWindowDays(row.horizon)) continue;
    selected.push(row);
    lastDay = day;
    if (selected.length >= limit) break;
  }
  return selected;
}

export function evaluateEdgeReadiness(rows: EdgeReadinessInput[]): EdgeReadinessResult {
  if (!rows.length) throw new Error("edge readiness requires at least one identity row");
  const { edgeId, market, horizon } = rows[0];
  if (rows.some(row => row.edgeId !== edgeId || row.market !== market || row.horizon !== horizon)) {
    throw new Error("edge readiness rows must share edge, market, and horizon");
  }

  const historical = selectIndependentWindows(rows, HISTORICAL_WINDOWS_REQUIRED);
  const historicalMetrics = historical.map(row => ({
    ic: finite(row.ic), tStat: finite(row.tStat), nObs: finite(row.nObs),
  }));
  const completeHistorical = historicalMetrics.filter(
    (row): row is { ic: number; tStat: number; nObs: number } => row.ic != null && row.tStat != null && row.nObs != null,
  );
  const positiveWindows = completeHistorical.filter(row => row.ic > 0).length;
  const medianIc = median(completeHistorical.map(row => row.ic));
  const medianTStat = median(completeHistorical.map(row => row.tStat));
  const minNObs = completeHistorical.length ? Math.min(...completeHistorical.map(row => row.nObs)) : null;

  const enoughWindows = historical.length >= HISTORICAL_WINDOWS_REQUIRED;
  const completeMetrics = completeHistorical.length === HISTORICAL_WINDOWS_REQUIRED;
  const sampleGate = completeMetrics && minNObs != null && minNObs >= MIN_OBSERVATIONS_PER_WINDOW;
  const signGate = completeMetrics && positiveWindows >= 5;
  const icGate = completeMetrics && medianIc != null && medianIc >= 0.02;
  const tGate = completeMetrics && medianTStat != null && medianTStat >= 1.5;
  const historicalReady = enoughWindows && sampleGate && signGate && icGate && tGate;

  const validationCandidates = rows.filter(row =>
    row.evidenceQuality === VALIDATION_EVIDENCE_QUALITY
    && finite(row.netOfFeeIc) != null
    && finite(row.turnover) != null,
  );
  const validation = selectIndependentWindows(validationCandidates, VALIDATION_WINDOWS_REQUIRED);
  const validationMetrics = validation.map(row => ({
    net: finite(row.netOfFeeIc)!, turnover: finite(row.turnover)!,
  }));
  const positiveValidationWindows = validationMetrics.filter(row => row.net > 0).length;
  const medianNetOfFeeIc = median(validationMetrics.map(row => row.net));
  const validationReady = historicalReady
    && validation.length >= VALIDATION_WINDOWS_REQUIRED
    && positiveValidationWindows >= 3
    && medianNetOfFeeIc != null
    && medianNetOfFeeIc >= 0.01
    && validationMetrics.every(row => row.turnover >= 0);

  const stage: EdgeReadinessStage = validationReady
    ? "ready_for_shadow_review"
    : historicalReady
      ? "ready_for_validation_build"
      : enoughWindows
        ? "needs_stability"
        : "collecting";
  const nextAction = stage === "collecting"
    ? `Collect ${HISTORICAL_WINDOWS_REQUIRED - historical.length} more independent weekly window${HISTORICAL_WINDOWS_REQUIRED - historical.length === 1 ? "" : "s"}.`
    : stage === "needs_stability"
      ? "Keep the formula unchanged; stability or sample gates have not passed."
      : stage === "ready_for_validation_build"
        ? "Build or run PIT walk-forward, cost-adjusted, multiple-testing-controlled validation."
        : "Request owner review for admission to shadow scoring only.";

  return {
    edgeId, market, horizon,
    policyVersion: EDGE_READINESS_POLICY_VERSION,
    stage,
    windowsObserved: historical.length,
    windowsRequired: HISTORICAL_WINDOWS_REQUIRED,
    positiveWindows,
    medianIc,
    medianTStat,
    minNObs,
    latestWindowEnd: historical[0]?.windowEnd ?? null,
    validationWindowsObserved: validation.length,
    validationWindowsRequired: VALIDATION_WINDOWS_REQUIRED,
    positiveValidationWindows,
    medianNetOfFeeIc,
    nextAction,
    gates: {
      enough_windows: enoughWindows,
      complete_metrics: completeMetrics,
      min_observations: sampleGate,
      stable_positive_sign: signGate,
      median_ic: icGate,
      median_t_stat: tGate,
      validation_evidence_quality: validation.length >= VALIDATION_WINDOWS_REQUIRED,
      validation_positive_sign: positiveValidationWindows >= 3,
      validation_net_of_fee_ic: medianNetOfFeeIc != null && medianNetOfFeeIc >= 0.01,
      validation_turnover: validation.length >= VALIDATION_WINDOWS_REQUIRED && validationMetrics.every(row => row.turnover >= 0),
    },
  };
}
