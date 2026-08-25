const REVIEW_FLOOR = 20;
const ADJUSTMENT_FLOOR = 60;
// 60/120 grade the plan well past the mandate's 5-15 session hold. That is the
// point: they answer whether the 8% objective the plan set was reached AFTER
// the position was already closed, which is the "are we exiting too early"
// question the <=20d horizons structurally cannot ask.
const SUPPORTED_HORIZONS = [2, 5, 10, 20, 60, 120] as const;

export interface PlanCalibrationOutcome {
  horizonDays: number;
  referencePrice: number;
  riskFloor: number;
  profitObjective: number;
  stopLossPct: number;
  targetPct: number;
  forwardReturn: number;
  benchmarkNeutralReturn: number | null;
  maxAdverseExcursion: number;
  maxFavorableExcursion: number;
  objectiveReached: boolean;
  stopBreached: boolean;
  objectiveReachRatio: number;
}

export interface PlanCalibrationSummary {
  horizonDays: number;
  n: number;
  reviewFloor: number;
  adjustmentFloor: number;
  reviewable: boolean;
  adjustmentReady: boolean;
  objectiveHitRate: number | null;
  stopBreachRate: number | null;
  bothTouchedRate: number | null;
  averageObjectiveReachRatio: number | null;
  averageForwardReturn: number | null;
  averageBenchmarkNeutralReturn: number | null;
  averageMfe: number | null;
  averageMae: number | null;
  warning: string | null;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

/**
 * Compare one original candidate risk plan with one immutable realized path.
 * The profit objective is an exit-policy level, not a terminal-price forecast.
 */
export function evaluatePlanCalibration(
  features: unknown,
  label: {
    horizon_days?: unknown;
    fwd_return?: unknown;
    benchmark_neutral_return?: unknown;
    max_adverse_excursion?: unknown;
    max_favorable_excursion?: unknown;
  },
): PlanCalibrationOutcome | null {
  const plan = (features as any)?.trade_plan;
  if (!plan || plan.kind !== "indicative_research_plan" || plan.status !== "candidate") return null;
  const horizonDays = finite(plan.horizon_sessions);
  const labelHorizon = finite(label.horizon_days);
  const referencePrice = finite(plan.reference_price);
  const stopLossPct = finite(plan.stop_loss_pct);
  const targetPct = finite(plan.target_pct);
  const forwardReturn = finite(label.fwd_return);
  const benchmarkNeutralReturn = finite(label.benchmark_neutral_return);
  const mae = finite(label.max_adverse_excursion);
  const mfe = finite(label.max_favorable_excursion);
  if (
    horizonDays == null || labelHorizon == null || horizonDays !== labelHorizon
    || !SUPPORTED_HORIZONS.includes(horizonDays as any)
    || referencePrice == null || referencePrice <= 0
    || stopLossPct == null || stopLossPct <= 0
    || targetPct == null || targetPct <= 0
    || forwardReturn == null || mae == null || mfe == null
  ) return null;

  const stopFraction = stopLossPct / 100;
  const targetFraction = targetPct / 100;
  return {
    horizonDays,
    referencePrice,
    riskFloor: rounded(referencePrice * (1 - stopFraction), 4),
    profitObjective: rounded(referencePrice * (1 + targetFraction), 4),
    stopLossPct,
    targetPct,
    forwardReturn,
    benchmarkNeutralReturn,
    maxAdverseExcursion: mae,
    maxFavorableExcursion: mfe,
    objectiveReached: mfe >= targetFraction,
    stopBreached: mae <= -stopFraction,
    objectiveReachRatio: rounded(mfe / targetFraction, 4),
  };
}

export function summarizePlanCalibration(
  horizonDays: number,
  outcomes: PlanCalibrationOutcome[],
): PlanCalibrationSummary {
  const matching = outcomes.filter(row => row.horizonDays === horizonDays);
  const n = matching.length;
  if (n === 0) {
    return {
      horizonDays, n, reviewFloor: REVIEW_FLOOR, adjustmentFloor: ADJUSTMENT_FLOOR,
      reviewable: false, adjustmentReady: false,
      objectiveHitRate: null, stopBreachRate: null, bothTouchedRate: null,
      averageObjectiveReachRatio: null, averageForwardReturn: null,
      averageBenchmarkNeutralReturn: null, averageMfe: null, averageMae: null,
      warning: "No matured candidate plans at this exact horizon.",
    };
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const benchmarkReturns = matching
    .map(row => row.benchmarkNeutralReturn)
    .filter((value): value is number => value != null);
  const reviewable = n >= REVIEW_FLOOR;
  const adjustmentReady = n >= ADJUSTMENT_FLOOR;
  return {
    horizonDays,
    n,
    reviewFloor: REVIEW_FLOOR,
    adjustmentFloor: ADJUSTMENT_FLOOR,
    reviewable,
    adjustmentReady,
    objectiveHitRate: rounded(matching.filter(row => row.objectiveReached).length / n, 4),
    stopBreachRate: rounded(matching.filter(row => row.stopBreached).length / n, 4),
    bothTouchedRate: rounded(matching.filter(row => row.objectiveReached && row.stopBreached).length / n, 4),
    averageObjectiveReachRatio: rounded(mean(matching.map(row => row.objectiveReachRatio)), 4),
    averageForwardReturn: rounded(mean(matching.map(row => row.forwardReturn)), 6),
    averageBenchmarkNeutralReturn: benchmarkReturns.length ? rounded(mean(benchmarkReturns), 6) : null,
    averageMfe: rounded(mean(matching.map(row => row.maxFavorableExcursion)), 6),
    averageMae: rounded(mean(matching.map(row => row.maxAdverseExcursion)), 6),
    warning: !reviewable
      ? `Only ${n}/${REVIEW_FLOOR} matured paths; per-symbol results are illustrative.`
      : !adjustmentReady
        ? `${n}/${ADJUSTMENT_FLOOR} matured paths; reviewable but not enough for risk-parameter adjustment.`
        : null,
  };
}

export async function loadPlanCalibration(
  supabase: any,
  market: "us" | "india",
): Promise<{ outcomes: PlanCalibrationOutcome[]; summaries: PlanCalibrationSummary[] }> {
  const rows: any[] = [];
  const pageSize = 500;
  for (let offset = 0; offset < 5000; offset += pageSize) {
    const { data, error } = await supabase
      .from("decision_observations")
      .select("id,features")
      .eq("market", market)
      .eq("entry_eligible", true)
      .eq("direction", "long")
      .order("ts", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`plan_calibration_observations:${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
  }
  const ids = rows.map((row: any) => row.id);
  if (ids.length === 0) {
    return { outcomes: [], summaries: SUPPORTED_HORIZONS.map(day => summarizePlanCalibration(day, [])) };
  }
  const labels: any[] = [];
  const idBatchSize = 200;
  for (let offset = 0; offset < ids.length; offset += idBatchSize) {
    const { data, error } = await supabase
      .from("observation_labels")
      .select("observation_id,horizon_days,fwd_return,benchmark_neutral_return,max_adverse_excursion,max_favorable_excursion")
      .in("observation_id", ids.slice(offset, offset + idBatchSize))
      .in("horizon_days", [...SUPPORTED_HORIZONS])
      .limit(idBatchSize * SUPPORTED_HORIZONS.length);
    if (error) throw new Error(`plan_calibration_labels:${error.message}`);
    labels.push(...(data ?? []));
  }
  const featuresById = new Map(rows.map((row: any) => [Number(row.id), row.features]));
  const outcomes = labels
    .map((label: any) => evaluatePlanCalibration(featuresById.get(Number(label.observation_id)), label))
    .filter((row: PlanCalibrationOutcome | null): row is PlanCalibrationOutcome => row != null);
  return {
    outcomes,
    summaries: SUPPORTED_HORIZONS.map(day => summarizePlanCalibration(day, outcomes)),
  };
}

export const PLAN_CALIBRATION_REVIEW_FLOOR = REVIEW_FLOOR;
export const PLAN_CALIBRATION_ADJUSTMENT_FLOOR = ADJUSTMENT_FLOOR;
