// Forward shadow of alternative score formulas (measure-only). Variants are PURE FUNCTIONS of dimension scores already stored on every
// decision observation, so nothing needs to be produced: definitions are pre-registered (immutable table, declared_at), and the evaluator
// judges only observations dated AFTER declaration. Observations before declaration are reported separately and labelled hindsight.
//
// Why: the 2026-10-14 audit (docs/audits/2026-10-14-us-book-vs-xlk-and-score-quality.md) found the live composite's top fifth underperformed
// while a fundamental-only ranking was positive in both halves of the window, but the variant choice was made with hindsight on 3 months.
// This module turns that observation into a test that cannot be fooled by hindsight.

import { computeSpearmanIC } from "@/lib/validation/feature-check";

export type Dim = "fundamental" | "technical" | "sentiment" | "insider_v2";
export const VARIANT_SET = "variant_set_v1";
export const MIN_CROSS_SECTION = 15;
export const MIN_SESSIONS = 20;
export const MIN_INDEPENDENT_WINDOWS = 12; // same evidence gate as the LLM council: sessions / horizon
export const BONFERRONI_T = 2.4; // 3 variants tested -> about p < 0.05 / 3 two-sided
export const HORIZONS = [5, 10] as const;

export interface VariantDef { id: string; label: string; weights: Partial<Record<Dim, number>> }

/** Frozen. Changing a weight means a new set id, never an edit: results are only comparable within a set. */
export const VARIANTS: readonly VariantDef[] = [
  { id: "fundamental_only", label: "Fundamental only", weights: { fundamental: 1 } },
  { id: "fundamental_sentiment", label: "Fundamental + sentiment", weights: { fundamental: 0.30, sentiment: 0.20 } },
  { id: "composite_ex_insider", label: "Current composite without insider", weights: { fundamental: 0.30, technical: 0.25, sentiment: 0.20 } },
];

export interface ObsRow {
  ts: string;
  symbol: string;
  y: number; // benchmark-neutral forward return at the horizon
  analyst: number | null; // the live composite, the baseline
  scores: Partial<Record<Dim, number | null>>;
  avail: Partial<Record<Dim, boolean>>; // from availability_mask: an unavailable dimension holds a neutral default and must not be ranked
}

/** Weighted mean of the variant's dimensions; null when any needed dimension is missing or unavailable (no neutral-default pollution). */
export function variantScore(def: VariantDef, row: ObsRow): number | null {
  let num = 0;
  let den = 0;
  for (const [dim, w] of Object.entries(def.weights) as Array<[Dim, number]>) {
    const v = row.scores[dim];
    if (v == null || !Number.isFinite(Number(v)) || row.avail[dim] === false) return null;
    num += w * Number(v);
    den += w;
  }
  return den > 0 ? num / den : null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };

/** Mean outcome of the top and bottom fifth by score (ties broken by symbol so results are reproducible). */
export function fifthMeans(items: ReadonlyArray<{ symbol: string; score: number; y: number }>): { top: number; bottom: number } | null {
  if (items.length < MIN_CROSS_SECTION) return null;
  const sorted = [...items].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const k = Math.ceil(sorted.length / 5);
  return { top: mean(sorted.slice(0, k).map((i) => i.y)), bottom: mean(sorted.slice(-k).map((i) => i.y)) };
}

export interface ScoreStats {
  meanIc: number | null;
  icT: number | null;
  topFifthExcess: number | null;
  bottomFifthExcess: number | null;
  spread: number | null;
  spreadT: number | null;
}
export interface VariantEval {
  variantId: string;
  horizonDays: number;
  sessions: number;
  avgCrossSection: number;
  independentWindows: number;
  variant: ScoreStats;
  baseline: ScoreStats; // the live composite on the SAME rows, so the comparison is paired
  classification: "insufficient_evidence" | "measured_descriptive";
  meetsAdoptionGate: boolean;
  reason: string;
}

function aggregate(perSession: Array<{ ic: number; top: number; bottom: number }>, horizon: number): ScoreStats {
  if (!perSession.length) return { meanIc: null, icT: null, topFifthExcess: null, bottomFifthExcess: null, spread: null, spreadT: null };
  const ics = perSession.map((s) => s.ic);
  const spreads = perSession.map((s) => s.top - s.bottom);
  const eff = Math.sqrt(perSession.length / horizon);
  const t = (xs: number[]) => (xs.length > 1 && sd(xs) > 0 ? (mean(xs) / sd(xs)) * eff : null);
  return {
    meanIc: mean(ics), icT: t(ics),
    topFifthExcess: mean(perSession.map((s) => s.top)), bottomFifthExcess: mean(perSession.map((s) => s.bottom)),
    spread: mean(spreads), spreadT: t(spreads),
  };
}

/** Evaluate one variant against the live composite on the same rows, session by session. */
export function evaluateVariant(def: VariantDef, rows: readonly ObsRow[], horizonDays: number): VariantEval {
  const bySession = new Map<string, Array<{ symbol: string; v: number; a: number; y: number }>>();
  for (const r of rows) {
    const v = variantScore(def, r);
    if (v == null || r.analyst == null || !Number.isFinite(Number(r.analyst)) || !Number.isFinite(r.y)) continue;
    const day = r.ts.slice(0, 10);
    const list = bySession.get(day) ?? [];
    list.push({ symbol: r.symbol, v, a: Number(r.analyst), y: r.y });
    bySession.set(day, list);
  }
  const vPer: Array<{ ic: number; top: number; bottom: number }> = [];
  const bPer: Array<{ ic: number; top: number; bottom: number }> = [];
  let crossTotal = 0;
  for (const items of bySession.values()) {
    const unique = [...new Map(items.map((i) => [i.symbol, i])).values()];
    if (unique.length < MIN_CROSS_SECTION) continue;
    const vi = computeSpearmanIC(unique.map((i) => i.v), unique.map((i) => i.y));
    const bi = computeSpearmanIC(unique.map((i) => i.a), unique.map((i) => i.y));
    const vf = fifthMeans(unique.map((i) => ({ symbol: i.symbol, score: i.v, y: i.y })));
    const bf = fifthMeans(unique.map((i) => ({ symbol: i.symbol, score: i.a, y: i.y })));
    if (!vi || !bi || !vf || !bf) continue;
    vPer.push({ ic: vi.ic, ...vf });
    bPer.push({ ic: bi.ic, ...bf });
    crossTotal += unique.length;
  }
  const sessions = vPer.length;
  const independentWindows = sessions / horizonDays;
  const variant = aggregate(vPer, horizonDays);
  const baseline = aggregate(bPer, horizonDays);
  const enough = sessions >= MIN_SESSIONS && independentWindows >= MIN_INDEPENDENT_WINDOWS;
  const meetsAdoptionGate = enough && variant.spread != null && baseline.spread != null && variant.spreadT != null
    && variant.spreadT >= BONFERRONI_T && variant.spread > baseline.spread && (variant.topFifthExcess ?? -1) > 0;
  return {
    variantId: def.id, horizonDays, sessions, avgCrossSection: sessions ? crossTotal / sessions : 0, independentWindows, variant, baseline,
    classification: enough ? "measured_descriptive" : "insufficient_evidence", meetsAdoptionGate,
    reason: enough
      ? `Descriptive per-session comparison; t-stats use sessions/horizon effective windows. Adoption additionally needs spread t >= ${BONFERRONI_T}, spread above the live composite, and a positive top-fifth excess.`
      : `${sessions} qualifying sessions yield ${independentWindows.toFixed(2)} independent windows; need at least ${MIN_SESSIONS} sessions and ${MIN_INDEPENDENT_WINDOWS} effective windows.`,
  };
}
