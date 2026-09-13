// Exit-geometry shadow — pure counterfactual over already-matured labels.
//
// MEASUREMENT ONLY. Nothing here changes a stop, a target, a time stop, an
// order, or any live/paper exit. It answers "what WOULD a different geometry
// have produced on decisions we already have outcomes for", so a geometry
// change can be argued from evidence instead of from a percentile picked off a
// two-date sample.
//
// WHY THIS EXISTS
// Earlier measurements were invalid because they compared candidate geometry to
// a retired hard-coded target. The caller must now provide the market's current
// mandate baseline. Shortening a target alone can still make expectancy worse,
// so the fix cannot be chosen without measuring the full pair first.
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
 * Candidate geometry. Each SIDE (stop, target) is expressed in either ATR
 * multiples or a fixed percentage, and the two sides are independent.
 *
 * Both modes exist for a measured reason. ATR multiples are the better contract
 * — comparable across markets, adapting to each name's volatility — while fixed
 * percentages are the incumbent supplied by the caller, so a percentage arm
 * tests the market's current configuration rather than an ATR approximation.
 *
 * COVERAGE NOTE, corrected 2026-09-01. This comment previously stated that
 * `entry_atr_pct` coverage "collapses with horizon (US 10-day: 3 of 74 labels,
 * 4.1%)". That was true when written and is now stale — the column has since
 * been backfilled. Measured 2026-09-01 on entry-eligible labelled rows:
 *
 *   us h10    847/900   94.1%        india h10   414/424   97.6%
 *   us h5    1272/1333  95.4%        india h5    531/541   98.2%
 *
 * ATR geometries are therefore evaluable across the whole cohort now, not a
 * sliver of it. Leaving the old figure in place would misrepresent an arm as
 * unmeasurable when it is not.
 *
 * MIXED SIDES are permitted and are the point of `features/atr-exit-stop`: an
 * ATR stop against the LIVE fixed target isolates the stop as the only varying term.
 * Exactly one of `stopPct`/`stopAtr` and one of `targetPct`/`targetAtr` must be
 * set; anything else resolves to null and classifies as ambiguous.
 */
export interface Geometry {
  stopPct?: number;
  targetPct?: number;
  stopAtr?: number;
  targetAtr?: number;
}

/** Resolve a geometry to concrete stop/target fractions for one decision. */
export function resolveLevels(point: LabelPoint, geometry: Geometry): { stopPct: number; targetPct: number } | null {
  // Each side resolves independently, so an ATR stop can be paired with a fixed
  // target. A side given BOTH units is ambiguous configuration, not a fallback.
  const side = (pct: number | undefined, atr: number | undefined): number | null => {
    if (pct != null && atr != null) return null;
    if (pct != null) return pct;
    if (atr != null) {
      // ATR mode needs a per-decision ATR. Without one the geometry is undefined
      // for this decision — it must not silently fall back to a percentage.
      return point.atrPct > 0 ? atr * point.atrPct : null;
    }
    return null;
  };
  const stopPct = side(geometry.stopPct, geometry.stopAtr);
  const targetPct = side(geometry.targetPct, geometry.targetAtr);
  if (stopPct == null || targetPct == null) return null;
  return { stopPct, targetPct };
}

export function geometryLabel(geometry: Geometry): string {
  const side = (pct: number | undefined, atr: number | undefined): string =>
    pct != null ? `${(pct * 100).toFixed(1)}%` : atr != null ? `${atr}ATR` : "undefined";
  return `stop ${side(geometry.stopPct, geometry.stopAtr)} / target ${side(geometry.targetPct, geometry.targetAtr)}`;
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
 * The incumbent must be supplied by the caller from the market's mandate. A
 * hard-coded "live" baseline caused this shadow to evaluate 7.5%/19.2% after
 * execution had moved elsewhere, which makes its result non-transferable. The
 * alternatives walk the target down toward the excursion available inside the
 * holding window while varying stop and target independently.
 */
export function buildCandidateGeometries(baseline: Geometry): readonly Geometry[] {
  if (!(baseline.stopPct && baseline.stopPct > 0 && baseline.targetPct && baseline.targetPct > 0)) return [];
  const raw: Geometry[] = [
  // Percentage grid. The FIRST entry is the caller-provided incumbent, so every
  // comparison has a real, market-local baseline.
  baseline,
  { stopPct: baseline.stopPct, targetPct: 0.100 },
  { stopPct: baseline.stopPct, targetPct: 0.060 },
  { stopPct: baseline.stopPct, targetPct: 0.040 },
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
  // A mandate can itself equal a predeclared percentage challenger. Report it
  // once rather than silently doubling its statistical weight in the trial family.
  const seen = new Set<string>();
  return raw.filter((geometry) => {
    const key = JSON.stringify(geometry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isBaseline(geometry: Geometry, baseline: Geometry): boolean {
  return geometry.stopPct === baseline.stopPct && geometry.targetPct === baseline.targetPct;
}
