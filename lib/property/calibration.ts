// Forecast calibration — pure.
//
// Answers "have our shadow forecasts actually been any good", and REFUSES to
// answer when the matured sample cannot carry the question.
//
// This codebase has repeatedly published a confident statistic from a handful of
// observations and had to retract it — a discovery-source cohort of 26 rows over
// 3 correlated days, an information coefficient computed over a single fortnight.
// Property forecasts will mature at roughly one per metric per quarter, so a
// coverage rate here would be built on single digits for a long time. The floor
// is therefore mechanical: below it the rate is NULL, not a number beside a
// caveat, because a caveat is something a reader skips.
//
// MEASUREMENT ONLY. Forecasts are shadow decision support. Nothing here reaches
// a securities score, an order, or any money path.

export interface MaturedOutcome {
  /** Was the actual value inside [lower, upper]? */
  intervalCovered: boolean;
  /** |actual - base|, in the metric's native unit. */
  absoluteError: number;
  /** The base prediction, used to express error as a percentage of scale. */
  baseValue: number;
}

export interface CalibrationSummary {
  metric: string;
  market: string;
  /** Matured outcomes for this cohort. Always reported, even when it is 0. */
  n: number;
  /** Null below MIN_MATURED_OUTCOMES — never a number the sample can't carry. */
  intervalCoveragePct: number | null;
  meanAbsoluteError: number | null;
  /** MAE as a percentage of the mean base value, so metrics are comparable. */
  meanAbsolutePercentError: number | null;
  sufficient: boolean;
}

/**
 * Matured outcomes required before a calibration rate is reported as a number.
 *
 * 10 is deliberately modest and still not "statistically sufficient" — an
 * interval claiming 80% coverage cannot be distinguished from one claiming 50%
 * at n=10. It is the floor below which a percentage is actively misleading
 * (at n=3, coverage can only ever read 0%, 33%, 67% or 100%).
 */
export const MIN_MATURED_OUTCOMES = 10;

export function summarizeCalibration(
  market: string,
  metric: string,
  outcomes: readonly MaturedOutcome[],
): CalibrationSummary {
  const usable = outcomes.filter((o) =>
    typeof o.intervalCovered === "boolean"
    && Number.isFinite(o.absoluteError)
    && o.absoluteError >= 0
    && Number.isFinite(o.baseValue)
    && o.baseValue > 0,
  );
  const n = usable.length;
  const base: CalibrationSummary = {
    metric, market, n,
    intervalCoveragePct: null,
    meanAbsoluteError: null,
    meanAbsolutePercentError: null,
    sufficient: n >= MIN_MATURED_OUTCOMES,
  };
  if (!base.sufficient) return base;

  const mae = usable.reduce((sum, o) => sum + o.absoluteError, 0) / n;
  return {
    ...base,
    intervalCoveragePct: usable.filter((o) => o.intervalCovered).length / n * 100,
    meanAbsoluteError: mae,
    // Mean of per-forecast percentage errors. `MAE / mean(base)` is normalized
    // MAE, not MAPE, and can materially differ when forecast scales vary.
    meanAbsolutePercentError: usable.reduce(
      (sum, o) => sum + o.absoluteError / Math.abs(o.baseValue), 0,
    ) / n * 100,
  };
}

/** Plain-language reason a cohort cannot yet be scored. Empty when it can. */
export function calibrationBlocker(summary: CalibrationSummary): string | null {
  if (summary.sufficient) return null;
  if (summary.n === 0) return "No forecast has matured for this metric yet.";
  return `${summary.n} of ${MIN_MATURED_OUTCOMES} matured outcomes. A coverage rate from ${summary.n} is not meaningful and is withheld.`;
}
