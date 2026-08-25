// Grades the archetype weighting arms recorded in `shadow_decisions` against
// realized benchmark-neutral forward returns.
//
// WHY THIS EXISTS
// Six weight sets have been scoring every observation in shadow, and nothing
// has ever graded them — the only consumer computed the share of shadow rows
// that were bullish, which compares nothing to anything. Meanwhile the measured
// champion composite scores BELOW its own best single dimension:
//
//   us    h10 rank IC   fundamental +0.076 (t=2.40)   composite +0.051 (t=0.93)
//   india h10 rank IC   technical   +0.173 (t=2.51)   composite +0.106 (t=2.04)
//
// That is the hypothesis this instrument tests: a differently-weighted blend
// should rank forward returns better than the live composite does.
//
// MEASURE-ONLY. Nothing here reaches scoring, sizing, entry or exit.

import { MIN_PREDICTIVE_DATES, MIN_CROSS_SECTION, MIN_EFFECTIVE_OBSERVATIONS, effectiveObservations } from "./dimension-diagnostics";

export interface ArchetypeScoreRow {
  market: "us" | "india";
  setupType: string;
  symbol: string;
  /** Decision date, YYYY-MM-DD. */
  date: string;
  /** Timestamp, used only to pick a deterministic winner among same-day duplicates. */
  ts: string;
  /** The archetype's score for this observation. */
  score: number;
  /** The live composite score for the SAME observation. */
  championScore: number;
  /** Realized benchmark-neutral forward return at the horizon. */
  forwardReturn: number;
}

export interface ArchetypeIcResult {
  market: "us" | "india";
  setupType: string;
  qualifyingSessions: number;
  observations: number;
  rankIc: number | null;
  rankIcT: number | null;
  championRankIc: number | null;
  icDeltaVsChampion: number | null;
  effectiveObs: number;
  status: "insufficient_evidence" | "measured";
  reason: string;
}

/**
 * One row per (market, symbol, date, setupType) — earliest ts wins.
 *
 * The research cron writes an observation on each run (13:00/17:00/18:00 UTC),
 * so a symbol appears 2-3x per date and would carry 2-3x weight inside a single
 * cross-section. Date-clustering handles independence BETWEEN dates; it does
 * nothing about duplicates WITHIN one.
 */
export function dedupeRows(rows: ArchetypeScoreRow[]): ArchetypeScoreRow[] {
  const best = new Map<string, ArchetypeScoreRow>();
  for (const r of rows) {
    const key = `${r.market}|${r.setupType}|${r.symbol}|${r.date}`;
    const prior = best.get(key);
    if (!prior || r.ts < prior.ts) best.set(key, r);
  }
  return [...best.values()];
}

/** Average ranks, so ties do not distort the correlation. */
function rank(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  // Zero variance on either side — every score identical, or every return
  // identical. Undefined, not zero: reporting 0.0 would read as "measured no
  // relationship" when nothing was measurable.
  return den === 0 ? null : num / den;
}

/** Spearman: Pearson on average ranks. */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length) return null;
  return pearson(rank(xs), rank(ys));
}

function tStat(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const varc = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(varc / n);
  return se === 0 ? null : mean / se;
}

/**
 * Grade one archetype in one market.
 *
 * The champion is measured on the SAME observations, never on a global
 * baseline: `etf_trend` only ever scores ETFs, so comparing its IC against a
 * whole-market champion figure would compare different universes. That exact
 * cohort mismatch inflated an earlier US-vs-India read by roughly 2x.
 */
export function computeArchetypeIc(
  rows: ArchetypeScoreRow[],
  horizonDays: number,
): ArchetypeIcResult | null {
  if (rows.length === 0) return null;
  const deduped = dedupeRows(rows);
  const market = deduped[0].market;
  const setupType = deduped[0].setupType;

  const byDate = new Map<string, ArchetypeScoreRow[]>();
  for (const r of deduped) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }

  const sessionIcs: number[] = [];
  const championIcs: number[] = [];
  for (const dayRows of byDate.values()) {
    if (dayRows.length < MIN_CROSS_SECTION) continue;
    const fwd = dayRows.map(r => r.forwardReturn);
    const ic = spearman(dayRows.map(r => r.score), fwd);
    const champIc = spearman(dayRows.map(r => r.championScore), fwd);
    if (ic == null || !Number.isFinite(ic)) continue;
    sessionIcs.push(ic);
    // Only keep the champion's IC for sessions the archetype also qualified on,
    // so the delta is paired rather than two independent averages.
    if (champIc != null && Number.isFinite(champIc)) championIcs.push(champIc);
  }

  const qualifyingSessions = sessionIcs.length;
  const nEff = effectiveObservations(qualifyingSessions, horizonDays);
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const rankIc = mean(sessionIcs);
  const championRankIc = mean(championIcs);

  const datesShort = qualifyingSessions < MIN_PREDICTIVE_DATES;
  const overlapShort = nEff < MIN_EFFECTIVE_OBSERVATIONS;
  const status: ArchetypeIcResult["status"] = datesShort || overlapShort ? "insufficient_evidence" : "measured";

  const reason = datesShort
    ? `Only ${qualifyingSessions}/${MIN_PREDICTIVE_DATES} sessions have a cross-section of at least ${MIN_CROSS_SECTION}; no weighting conclusion is permitted.`
    : overlapShort
      ? `${qualifyingSessions} sessions at a ${horizonDays}-day horizon overlap to only ${nEff.toFixed(2)} independent observations (need ${MIN_EFFECTIVE_OBSERVATIONS}); no weighting conclusion is permitted.`
      : "Descriptive session-level rank IC vs the champion composite on the same observations. Not a promotion result and not a recommendation to change live weights.";

  return {
    market,
    setupType,
    qualifyingSessions,
    observations: deduped.length,
    rankIc,
    rankIcT: tStat(sessionIcs),
    championRankIc,
    icDeltaVsChampion: rankIc != null && championRankIc != null ? rankIc - championRankIc : null,
    effectiveObs: nEff,
    status,
    reason,
  };
}
