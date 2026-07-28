// Purged out-of-sample fold engine — features/walk-forward-ic-folds steps 5-6.
//
// Builds DISJOINT test folds over market sessions and aggregates the resulting
// out-of-sample IC series. Pure: no network, no database, no clock. Callers
// supply the session calendar and the per-date ICs.
//
// Mode is `purged_temporal_oos`, approved 2026-07-28 (Annex D): nothing in the
// edge pipeline is fitted, so a fold has NO training segment. Folds exist only
// as diagnostics — sign consistency and a worst-fold guard. The promotion
// statistic is the aggregate HAC t over the CONCATENATED series. For a fixed
// series the aggregate is partition-independent; purge width, entitlement
// depth, and fold-level gates can still change the usable series (Annex J).
//
// Purge is measured in SESSIONS, not calendar days: the last as-of date in a
// fold needs `horizonSessions` more sessions for its forward return to mature,
// and the next fold may not begin until after that. Without it, fold k's label
// window overlaps fold k+1's features and the folds are not independent.

import { neweyWestLag } from "@/lib/edges/evidence";
import { neweyWestSEofMean } from "@/lib/edges/ic";

/**
 * Annex F: every sample floor assumes the cross-sectional rank-IC sd collapses
 * toward its theoretical value (~0.071 at n=200) once window overlap is removed.
 * The legacy 0.438 value was HAC-implied rather than a directly measured sample
 * sd. A realized estimate above 0.10 is a planning warning, not promotion
 * evidence or a statistically conclusive invalidation by itself.
 */
export const SIGMA_PLAN_CEILING = 0.10;

export interface FoldPlan {
  /** Market sessions in ascending order (trading dates only, no weekends/holidays). */
  sessions: string[];
  /** Forward-return horizon in sessions. */
  horizonSessions: number;
  /** Number of disjoint test folds. */
  foldCount: number;
  /** As-of dates per fold. */
  datesPerFold: number;
  /** Sessions between consecutive as-of dates. Equal to the horizon = no label overlap. */
  stepSessions: number;
}

export interface Fold {
  index: number;
  asOfDates: string[];
  /** Session on which the LAST as-of date's forward return matures. */
  labelEndDate: string;
  startIndex: number;
  labelEndIndex: number;
}

export type FoldBuildResult =
  | { ok: true; folds: Fold[]; sessionsRequired: number; sessionsAvailable: number }
  | { ok: false; reason: string; detail: string; sessionsRequired: number; sessionsAvailable: number };

/** Sessions one fold consumes: its as-of dates plus the final label's maturity. */
export function sessionsPerFold(p: Pick<FoldPlan, "horizonSessions" | "datesPerFold" | "stepSessions">): number {
  return (p.datesPerFold - 1) * p.stepSessions + p.horizonSessions + 1;
}

/**
 * Lay out consecutive disjoint folds from the OLDEST session forward, so fold 0
 * is earliest and the most recent sessions are used last. Fails closed when the
 * calendar cannot supply every fold at full width — a short final fold would be
 * a different-sized sample masquerading as a peer of the others.
 */
export function buildPurgedFolds(plan: FoldPlan): FoldBuildResult {
  const { sessions, horizonSessions, foldCount, datesPerFold, stepSessions } = plan;
  const available = sessions.length;
  const per = sessionsPerFold(plan);
  const required = per * foldCount;

  if (horizonSessions < 1 || foldCount < 1 || datesPerFold < 1 || stepSessions < 1) {
    return { ok: false, reason: "invalid_plan", detail: "horizon, foldCount, datesPerFold and step must all be >= 1.", sessionsRequired: required, sessionsAvailable: available };
  }
  if (stepSessions < horizonSessions) {
    // Overlapping labels are exactly what makes the legacy windows unusable.
    return {
      ok: false,
      reason: "step_below_horizon",
      detail: `stepSessions=${stepSessions} < horizonSessions=${horizonSessions}: consecutive as-of dates would share forward-return windows, so the IC series would be autocorrelated by construction.`,
      sessionsRequired: required, sessionsAvailable: available,
    };
  }
  if (available < required) {
    return {
      ok: false,
      reason: "insufficient_sessions",
      detail: `${foldCount} folds x ${datesPerFold} dates at step ${stepSessions} with horizon ${horizonSessions} needs ${required} sessions; ${available} available.`,
      sessionsRequired: required, sessionsAvailable: available,
    };
  }

  const folds: Fold[] = [];
  let cursor = 0;
  for (let k = 0; k < foldCount; k++) {
    const asOfIdx: number[] = [];
    for (let d = 0; d < datesPerFold; d++) asOfIdx.push(cursor + d * stepSessions);
    const labelEndIndex = asOfIdx[asOfIdx.length - 1] + horizonSessions;
    folds.push({
      index: k,
      asOfDates: asOfIdx.map((i) => sessions[i]),
      labelEndDate: sessions[labelEndIndex],
      startIndex: cursor,
      labelEndIndex,
    });
    cursor = labelEndIndex + 1; // purge: next fold starts only after this label matures
  }
  return { ok: true, folds, sessionsRequired: required, sessionsAvailable: available };
}

/**
 * Independent re-derivation that folds are genuinely disjoint. Deliberately not
 * a boolean the builder sets about itself — the architecture requires the gate
 * to recompute non-overlap rather than trust a flag.
 */
export function validateFoldDisjointness(folds: Fold[]): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (let k = 1; k < folds.length; k++) {
    const prev = folds[k - 1], cur = folds[k];
    if (cur.startIndex <= prev.labelEndIndex) {
      violations.push(
        `fold ${cur.index} starts at session ${cur.startIndex} but fold ${prev.index}'s label matures at ${prev.labelEndIndex} — the earlier fold's forward returns overlap the later fold's features.`,
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

export interface OosIcAggregate {
  n: number;
  meanIc: number;
  /** Realized sd of the OOS IC series — the Annex F headline number. */
  sigmaIc: number;
  /** Newey-West SE of the mean, Bartlett kernel. */
  seHac: number;
  tHac: number;
  lag: number;
  /** Point-estimate comparison only; false is a planning warning, not a gate. */
  sigmaWithinPlan: boolean;
  foldSigns: number[];
}

/**
 * Aggregate the concatenated OOS IC series.
 *
 * Reports `sigmaIc` and `sigmaWithinPlan` FIRST because Annex F makes the whole
 * approved plan conditional on it: at sigma 0.071 the floors need ~13 as-of
 * dates, at 0.10 they need 25 (exactly what is available), and at the legacy
 * measured 0.438 they would need ~480. A caller must check `sigmaWithinPlan`
 * before treating `tHac` as meaningful.
 */
export function aggregateOosIc(
  perDateIc: Array<{ date: string; ic: number; foldIndex: number }>,
  horizonSessions: number,
  stepSessions: number,
): OosIcAggregate | null {
  const rows = perDateIc
    .filter((r) => Number.isFinite(r.ic))
    .sort((a, b) => a.date.localeCompare(b.date));
  const n = rows.length;
  if (n < 2) return null;

  const xs = rows.map((r) => r.ic);
  const meanIc = xs.reduce((s, v) => s + v, 0) / n;
  // Sample sd (n-1): this is an estimate of the population sd, not a descriptive
  // spread, and Annex F compares it against a theoretical value.
  const sigmaIc = Math.sqrt(xs.reduce((s, v) => s + (v - meanIc) ** 2, 0) / (n - 1));

  const lag = neweyWestLag(horizonSessions, stepSessions);
  const seHac = neweyWestSEofMean(xs, lag);
  const tHac = Number.isFinite(seHac) && seHac > 0 ? meanIc / seHac : NaN;

  const byFold = new Map<number, number>();
  for (const r of rows) byFold.set(r.foldIndex, (byFold.get(r.foldIndex) ?? 0) + r.ic);
  const foldSigns = [...byFold.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, sum]) => Math.sign(sum));

  return {
    n, meanIc, sigmaIc, seHac, tHac, lag,
    sigmaWithinPlan: Number.isFinite(sigmaIc) && sigmaIc <= SIGMA_PLAN_CEILING,
    foldSigns,
  };
}
