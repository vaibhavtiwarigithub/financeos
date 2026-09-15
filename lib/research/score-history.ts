// Shaping research-run scores into a per-day series for the Score History chart.
//
// Kept out of the route so the collapsing rule is testable on its own: it is the
// only place that decides what "the score on day X" means when a symbol was
// researched more than once that day.

export interface ScoreSignalRow {
  created_at: string;
  analyst_score: number | null;
  fundamental_score: number | string | null;
  technical_score: number | string | null;
  sentiment_score: number | string | null;
  macro_score: number | string | null;
  insider_score: number | string | null;
  direction: string | null;
  conviction: number | null;
  score_source: string | null;
  scoring_version: string | null;
}

export interface ScorePoint {
  date: string;
  analyst: number | null;
  fundamental: number | null;
  technical: number | null;
  sentiment: number | null;
  macro: number | null;
  insider: number | null;
  direction: string | null;
  conviction: number | null;
  score_source: string | null;
  scoring_version: string | null;
  /** How many research runs happened that day. >1 means this is the last one. */
  runs: number;
}

/** Postgres numerics arrive as strings over PostgREST. */
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Collapse research runs to one point per calendar day, keeping the LAST run.
 *
 * A symbol is sometimes researched twice in a day (STM was, on 2026-08-31 and
 * 2026-09-01). Plotting both puts two points on the same x value, which recharts
 * renders as a vertical spike that looks like score volatility that never
 * happened. Averaging them would invent a score no run ever produced, so the
 * last run of the day wins — it is the one that was actually standing at the
 * close, and it is a real observation rather than a derived one.
 *
 * Rows must be ordered by created_at ascending; the route asks for that.
 */
export function toScorePoints(rows: ScoreSignalRow[]): ScorePoint[] {
  const byDay = new Map<string, ScorePoint>();

  for (const r of rows) {
    if (!r?.created_at) continue;
    const date = String(r.created_at).slice(0, 10);
    const prior = byDay.get(date);
    byDay.set(date, {
      date,
      analyst: num(r.analyst_score),
      fundamental: num(r.fundamental_score),
      technical: num(r.technical_score),
      sentiment: num(r.sentiment_score),
      macro: num(r.macro_score),
      insider: num(r.insider_score),
      direction: r.direction ?? null,
      conviction: num(r.conviction),
      score_source: r.score_source ?? null,
      scoring_version: r.scoring_version ?? null,
      runs: (prior?.runs ?? 0) + 1,
    });
  }

  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The dimensions the chart plots, in legend order. */
export const SCORE_DIMENSIONS = [
  { key: "analyst",     label: "Analyst (weighted)", color: "#ef4444", emphasis: true },
  { key: "fundamental", label: "Fundamental",        color: "#6366f1", emphasis: false },
  { key: "technical",   label: "Technical",          color: "#f59e0b", emphasis: false },
  { key: "sentiment",   label: "Sentiment",          color: "#10b981", emphasis: false },
  { key: "macro",       label: "Macro",              color: "#8b5cf6", emphasis: false },
  { key: "insider",     label: "Insider",            color: "#14b8a6", emphasis: false },
] as const;

export type ScoreDimensionKey = (typeof SCORE_DIMENSIONS)[number]["key"];
