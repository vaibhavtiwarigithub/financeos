// Evaluator for the India LLM event score (measure-only). Uses the same session-level rank-IC discipline as the council
// (per-session cross-sectional Spearman, t-stat on horizon-adjusted effective windows, 20 sessions / 12 windows gate), and adds:
//  - partial IC: does the event score predict benchmark-neutral returns AFTER removing what the deterministic composite and
//    the council median already explain? (rank-residual correlation per session)
//  - redundancy: per-session Spearman between the event score and the council / composite.
// All series are computed on the SAME paired sample so differences are not sample artefacts.

import { computeSpearmanIC } from "@/lib/validation/feature-check";
import { MIN_COUNCIL_EFFECTIVE_WINDOWS, MIN_COUNSEL_CROSS_SECTION } from "@/lib/llm-council/core";
import { ols } from "@/lib/india-macro-exposure";

export const EVENT_SCORE_MAX_AGE_MS = 3 * 86_400_000;
export const REDUNDANCY_CORRELATION = 0.6;
const MIN_PARTIAL_CROSS_SECTION = MIN_COUNSEL_CROSS_SECTION + 3;
const MIN_SESSIONS = 20;

export interface EventScoreRow { symbol: string; as_of: string; score: number }
export interface PairedRow { symbol: string; ts: string; event: number; council: number; analyst: number; outcome: number }
export interface ObservationRow { symbol: string; ts: string; council: number | null; analyst: number | null; outcome: number | null }

export interface EvalCell {
  seriesKey: string;
  horizonDays: number;
  observationCount: number;
  qualifyingSessions: number;
  independentWindows: number;
  mean: number | null;
  sd: number | null;
  tStat: number | null;
  classification: "insufficient_evidence" | "measured_descriptive";
  reason: string;
}

/** For each observation, the latest event score computed at or before the observation time and not older than 3 days. */
export function pairEventScores(observations: readonly ObservationRow[], scores: readonly EventScoreRow[]): PairedRow[] {
  const bySymbol = new Map<string, Array<{ t: number; score: number }>>();
  for (const s of scores) {
    const t = Date.parse(s.as_of);
    if (!Number.isFinite(t) || !Number.isFinite(s.score)) continue;
    const list = bySymbol.get(s.symbol) ?? [];
    list.push({ t, score: s.score });
    bySymbol.set(s.symbol, list);
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.t - b.t);
  const out: PairedRow[] = [];
  for (const o of observations) {
    if (o.council == null || o.analyst == null || o.outcome == null) continue;
    if (![o.council, o.analyst, o.outcome].every(Number.isFinite)) continue;
    const ts = Date.parse(o.ts);
    const list = bySymbol.get(o.symbol);
    if (!Number.isFinite(ts) || !list) continue;
    let best: { t: number; score: number } | null = null;
    for (const s of list) { if (s.t <= ts) best = s; else break; } // never uses a score computed after the observation
    if (!best || ts - best.t > EVENT_SCORE_MAX_AGE_MS) continue;
    out.push({ symbol: o.symbol, ts: o.ts, event: best.score, council: o.council, analyst: o.analyst, outcome: o.outcome });
  }
  return out;
}

function rank(values: readonly number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

function residuals(y: readonly number[], X: number[][]): number[] | null {
  const fit = ols([...y], X);
  if (!fit) return null;
  return y.map((v, i) => v - (fit.coef[0] + X[i].reduce((s, x, j) => s + x * fit.coef[j + 1], 0)));
}

function groupBySession(rows: readonly PairedRow[]): PairedRow[][] {
  const byDate = new Map<string, Map<string, PairedRow>>();
  for (const r of rows) {
    const d = r.ts.slice(0, 10);
    const m = byDate.get(d) ?? new Map<string, PairedRow>();
    m.set(r.symbol, r);
    byDate.set(d, m);
  }
  return [...byDate.values()].map((m) => [...m.values()]);
}

function summarize(seriesKey: string, horizonDays: number, perSession: number[], observationCount: number, noun: string): EvalCell {
  const sessions = perSession.length;
  const independentWindows = sessions / horizonDays;
  const mean = sessions ? perSession.reduce((a, b) => a + b, 0) / sessions : null;
  const sd = sessions > 1 && mean != null ? Math.sqrt(perSession.reduce((s, v) => s + (v - mean) ** 2, 0) / (sessions - 1)) : null;
  const enough = independentWindows >= MIN_COUNCIL_EFFECTIVE_WINDOWS && sessions >= MIN_SESSIONS;
  const tStat = enough && mean != null && sd != null && sd > 0 ? mean / (sd / Math.sqrt(independentWindows)) : null;
  return {
    seriesKey, horizonDays, observationCount, qualifyingSessions: sessions, independentWindows, mean, sd, tStat,
    classification: enough ? "measured_descriptive" : "insufficient_evidence",
    reason: enough
      ? `Descriptive ${noun}; t-stat uses horizon-overlap-adjusted effective windows. Not causal evidence.`
      : `${sessions} qualifying sessions yield ${independentWindows.toFixed(2)} independent windows; need at least ${MIN_SESSIONS} sessions and ${MIN_COUNCIL_EFFECTIVE_WINDOWS} effective windows.`,
  };
}

type Pick = (r: PairedRow) => number;

/** Per-session Spearman IC of one paired column against the benchmark-neutral outcome. */
export function icCell(seriesKey: string, horizonDays: number, rows: readonly PairedRow[], pick: Pick): EvalCell {
  const ics: number[] = [];
  let n = 0;
  for (const section of groupBySession(rows)) {
    if (section.length < MIN_COUNSEL_CROSS_SECTION) continue;
    const ic = computeSpearmanIC(section.map(pick), section.map((r) => r.outcome));
    if (!ic) continue;
    ics.push(ic.ic);
    n += section.length;
  }
  return summarize(seriesKey, horizonDays, ics, n, "per-session Spearman IC");
}

/** Per-session Spearman correlation between two paired columns (redundancy measure). */
export function correlationCell(seriesKey: string, horizonDays: number, rows: readonly PairedRow[], a: Pick, b: Pick): EvalCell {
  const cs: number[] = [];
  let n = 0;
  for (const section of groupBySession(rows)) {
    if (section.length < MIN_COUNSEL_CROSS_SECTION) continue;
    const c = computeSpearmanIC(section.map(a), section.map(b));
    if (!c) continue;
    cs.push(c.ic);
    n += section.length;
  }
  return summarize(seriesKey, horizonDays, cs, n, "per-session rank correlation");
}

/** Partial rank IC of the event score vs outcome, controlling for composite and council ranks within each session. */
export function partialIcCell(seriesKey: string, horizonDays: number, rows: readonly PairedRow[]): EvalCell {
  const pics: number[] = [];
  let n = 0;
  for (const section of groupBySession(rows)) {
    if (section.length < MIN_PARTIAL_CROSS_SECTION) continue;
    const ctrl = rank(section.map((r) => r.analyst)).map((a, i) => [a, rank(section.map((r) => r.council))[i]]);
    const ev = residuals(rank(section.map((r) => r.event)), ctrl);
    const out = residuals(rank(section.map((r) => r.outcome)), ctrl);
    if (!ev || !out) continue;
    const c = pearson(ev, out);
    if (c == null) continue;
    pics.push(c);
    n += section.length;
  }
  return summarize(seriesKey, horizonDays, pics, n, "per-session partial rank IC controlling for composite and council");
}

export function evaluatePairs(horizonDays: number, rows: readonly PairedRow[]): EvalCell[] {
  const cells = [
    icCell("event:score", horizonDays, rows, (r) => r.event),
    icCell("council:median_paired", horizonDays, rows, (r) => r.council),
    icCell("deterministic:analyst_score_paired", horizonDays, rows, (r) => r.analyst),
    partialIcCell("event:partial_vs_composite_council", horizonDays, rows),
    correlationCell("corr:event_vs_council", horizonDays, rows, (r) => r.event, (r) => r.council),
    correlationCell("corr:event_vs_composite", horizonDays, rows, (r) => r.event, (r) => r.analyst),
  ];
  const corr = cells.find((c) => c.seriesKey === "corr:event_vs_council");
  if (corr?.mean != null && corr.classification === "measured_descriptive" && Math.abs(corr.mean) >= REDUNDANCY_CORRELATION) {
    corr.reason += ` Mean correlation ${corr.mean.toFixed(2)} >= ${REDUNDANCY_CORRELATION}: the event score is redundant with the council.`;
  }
  return cells;
}
