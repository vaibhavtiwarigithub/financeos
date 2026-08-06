// Exit-geometry shadow — pure counterfactual over already-matured labels.
//
// MEASUREMENT ONLY. Nothing here changes a stop, a target, a time stop, an
// order, or any live/paper exit. It answers "what WOULD a different geometry
// have produced on decisions we already have outcomes for", so a geometry
// change can be argued from evidence instead of from a percentile picked off a
// two-date sample.
//
// WHY THIS EXISTS
// `features/portfolio-underperformance/DIAGNOSIS.md` §12 measured that the
// configured target (+19.2%) sits far beyond even the p90 favourable excursion
// over the 10-day holding period the time stop enforces, so it is unreachable by
// construction: 1 of 73 closed trades exited at target, against 47 on the clock.
// But shortening the target alone drops reward:risk below 1 and makes expectancy
// WORSE, so the fix cannot be chosen without measuring it first.
//
// THE PATH-DEPENDENCY TRAP — the reason this module is careful
// Matured labels store max favourable and max adverse excursion, NOT the price
// path. When a window's MFE clears the target AND its MAE breaches the stop,
// the summary statistics cannot say which happened first. Assuming the good one
// is how a backtest invents an edge. Those cases are classified `ambiguous`,
// reported separately, and excluded from the outcome mean. If the ambiguous
// share is large, the comparison is not usable — and saying so is the point.

/** One matured decision, expressed in returns and its entry-time volatility. */
export interface LabelPoint {
  /** Max favourable excursion over the window, as a fraction (0.05 = +5%). */
  mfe: number;
  /** Max adverse excursion, as a NEGATIVE fraction (-0.03 = -3%). */
  mae: number;
  /** Realised return at the end of the window — the time-stop outcome. */
  fwd: number;
  /** Entry ATR as a fraction of price. Geometry is expressed in ATR multiples. */
  atrPct: number;
}

/**
 * Candidate geometry, in EITHER ATR multiples or fixed percentages.
 *
 * Both modes exist for a measured reason. ATR multiples are the better contract
 * — they are comparable across markets and adapt to each name's volatility — but
 * `entry_atr_pct` coverage collapses with horizon (US 10-day: 3 of 74 labels,
 * 4.1%), because 10-day labels mature from the OLDEST decisions, which predate
 * the column being populated. Evaluating ATR-only left the US arm with n=1.
 *
 * Fixed percentages are also what the system ACTUALLY runs today (-7.5% stop,
 * +19.2% target), so a percentage grid tests the live configuration directly
 * rather than an ATR approximation of it. Coverage will shift toward ATR as
 * newer decisions mature.
 */
export type Geometry =
  | { stopAtr: number; targetAtr: number; stopPct?: undefined; targetPct?: undefined }
  | { stopPct: number; targetPct: number; stopAtr?: undefined; targetAtr?: undefined };

/** Resolve a geometry to concrete stop/target fractions for one decision. */
export function resolveLevels(point: LabelPoint, geometry: Geometry): { stopPct: number; targetPct: number } | null {
  if (geometry.stopPct != null && geometry.targetPct != null) {
    return { stopPct: geometry.stopPct, targetPct: geometry.targetPct };
  }
  if (geometry.stopAtr != null && geometry.targetAtr != null) {
    // ATR mode needs a per-decision ATR. Without one the geometry is undefined
    // for this decision — it must not silently fall back to a percentage.
    if (!(point.atrPct > 0)) return null;
    return { stopPct: geometry.stopAtr * point.atrPct, targetPct: geometry.targetAtr * point.atrPct };
  }
  return null;
}

export function geometryLabel(geometry: Geometry): string {
  return geometry.stopPct != null
    ? `stop ${(geometry.stopPct * 100).toFixed(1)}% / target ${(geometry.targetPct! * 100).toFixed(1)}%`
    : `stop ${geometry.stopAtr}ATR / target ${geometry.targetAtr}ATR`;
}

export type ShadowOutcome = "target" | "stop" | "timeout" | "ambiguous";

export interface ClassifiedExit {
  outcome: ShadowOutcome;
  /** Return booked under this geometry. Null when ambiguous — never guessed. */
  ret: number | null;
}

/**
 * Classify one decision under one geometry.
 *
 * Four cases, and the fourth is the honest one:
 *   - target reached, stop never breached  -> target, booked at +targetPct
 *   - stop breached, target never reached  -> stop, booked at -stopPct
 *   - neither                              -> timeout, booked at fwd
 *   - BOTH                                 -> ambiguous, booked at null
 */
export function classifyExit(point: LabelPoint, geometry: Geometry): ClassifiedExit {
  if (!Number.isFinite(point.mfe) || !Number.isFinite(point.mae)) {
    return { outcome: "ambiguous", ret: null };
  }
  const levels = resolveLevels(point, geometry);
  // An ATR geometry on a decision with no recorded ATR is undefined, not zero.
  if (!levels) return { outcome: "ambiguous", ret: null };
  const { stopPct, targetPct } = levels;

  const hitTarget = point.mfe >= targetPct;
  // mae is negative; a stop at 2 ATR is breached when mae <= -2*atrPct.
  const hitStop = point.mae <= -stopPct;

  if (hitTarget && hitStop) return { outcome: "ambiguous", ret: null };
  if (hitTarget) return { outcome: "target", ret: targetPct };
  if (hitStop) return { outcome: "stop", ret: -stopPct };
  return { outcome: "timeout", ret: Number.isFinite(point.fwd) ? point.fwd : null };
}

export interface GeometryResult {
  geometry: Geometry;
  n: number;
  target: number;
  stop: number;
  timeout: number;
  ambiguous: number;
  /** Share of decisions whose ordering cannot be resolved from summary stats. */
  ambiguousShare: number;
  /** Mean over RESOLVED outcomes only. Null when nothing resolved. */
  meanReturn: number | null;
  winRate: number | null;
  /** True when the ambiguous share is small enough for the mean to mean anything. */
  usable: boolean;
}

/**
 * Above this share of unresolvable orderings, the comparison is not evidence.
 * 0.2 is a judgement, stated rather than hidden: at one in five decisions
 * unresolved, the mean can be moved either way by the assumption you decline to
 * make, which is precisely the assumption a backtest should not be making.
 */
export const MAX_AMBIGUOUS_SHARE = 0.2;

export function evaluateGeometry(points: readonly LabelPoint[], geometry: Geometry): GeometryResult {
  let target = 0, stop = 0, timeout = 0, ambiguous = 0;
  const returns: number[] = [];

  for (const point of points) {
    const c = classifyExit(point, geometry);
    if (c.outcome === "target") target++;
    else if (c.outcome === "stop") stop++;
    else if (c.outcome === "timeout") timeout++;
    else ambiguous++;
    if (c.ret != null) returns.push(c.ret);
  }

  const n = points.length;
  const ambiguousShare = n === 0 ? 1 : ambiguous / n;
  const meanReturn = returns.length ? returns.reduce((s, x) => s + x, 0) / returns.length : null;
  const winRate = returns.length ? returns.filter((x) => x > 0).length / returns.length : null;

  return {
    geometry, n, target, stop, timeout, ambiguous, ambiguousShare, meanReturn, winRate,
    usable: n > 0 && ambiguousShare <= MAX_AMBIGUOUS_SHARE,
  };
}

/**
 * Candidate grid. Deliberately includes the CURRENT configured geometry as a
 * baseline — a comparison with no incumbent is a sales pitch, not a test.
 *
 * Current live config is a -7.5% stop and a +19.2% target. At the measured entry
 * ATR (US ~2.9%, India ~2.3%) that is roughly 2.8 ATR and 7.3 ATR, which is why
 * the baseline sits where it does. The alternatives walk the target down toward
 * the excursion actually available inside the holding window while varying the
 * stop independently, so target and stop effects can be separated.
 */
export const CANDIDATE_GEOMETRIES: readonly Geometry[] = [
  // Percentage grid. The FIRST entry is the live configuration exactly as
  // deployed, so every comparison has a real incumbent.
  { stopPct: 0.075, targetPct: 0.192 }, // BASELINE — the live config
  { stopPct: 0.075, targetPct: 0.100 },
  { stopPct: 0.075, targetPct: 0.060 },
  { stopPct: 0.075, targetPct: 0.040 },
  { stopPct: 0.050, targetPct: 0.100 },
  { stopPct: 0.050, targetPct: 0.060 },
  { stopPct: 0.050, targetPct: 0.040 },
  { stopPct: 0.035, targetPct: 0.060 },
  { stopPct: 0.035, targetPct: 0.040 },
  // ATR grid — the better contract once entry_atr_pct coverage recovers at the
  // traded horizon. Reported alongside so the two can be compared as coverage
  // shifts, rather than swapped over silently later.
  { stopAtr: 2.8, targetAtr: 7.3 },
  { stopAtr: 2.8, targetAtr: 2.5 },
  { stopAtr: 2.0, targetAtr: 2.5 },
  { stopAtr: 2.0, targetAtr: 1.5 },
  { stopAtr: 1.5, targetAtr: 1.5 },
];

export const BASELINE_GEOMETRY: Geometry = CANDIDATE_GEOMETRIES[0];

export function isBaseline(geometry: Geometry): boolean {
  return geometry.stopPct === BASELINE_GEOMETRY.stopPct
    && geometry.targetPct === BASELINE_GEOMETRY.targetPct;
}
