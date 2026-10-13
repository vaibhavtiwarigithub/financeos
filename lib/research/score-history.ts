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
  /** LLM council (shadow): median of the three members and each member's final score; null when not scored that day. */
  council?: number | null;
  council_deepseek?: number | null;
  council_claude?: number | null;
  council_codex?: number | null;
  council_runs?: number;
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
  { key: "council",     label: "LLM council (shadow)", color: "#ec4899", emphasis: false },
] as const;

export type ScoreDimensionKey = (typeof SCORE_DIMENSIONS)[number]["key"];

// ── LLM council as a score dimension (shadow) ───────────────────────────────
// The council scores every new research observation with three members. Stored forecasts only; this never calls a
// model. A day is shown the same way research scores are: the LAST council run of the day wins.

export interface CouncilRunRow { id: string; decision_ts: string; status: string; consensus_score: number | string | null }
export interface CouncilForecastRow { run_id: string; model_requested: string; final_score: number | string | null }
export type CouncilMember = "deepseek" | "claude" | "codex";

/** Member family of a requested model id; unknown models are not guessed at. */
export function councilMemberOf(model: string): CouncilMember | null {
  const m = String(model).toLowerCase();
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("claude")) return "claude";
  if (m.startsWith("gpt") || m.includes("codex")) return "codex";
  return null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One council point per day (last run of the day). `council` is the run's stored consensus when it has one; a run that was
 * backfilled after finalization keeps a null consensus, so the deterministic median of its THREE member scores is used
 * instead, and only when all three exist (a median of two members would invent a council opinion).
 */
export function toCouncilPoints(runs: CouncilRunRow[], forecasts: CouncilForecastRow[]): Array<Required<Pick<ScorePoint, "date" | "council" | "council_deepseek" | "council_claude" | "council_codex" | "council_runs">>> {
  const byRun = new Map<string, CouncilForecastRow[]>();
  for (const f of forecasts) { const l = byRun.get(f.run_id) ?? []; l.push(f); byRun.set(f.run_id, l); }
  const byDay = new Map<string, ReturnType<typeof toCouncilPoints>[number]>();
  for (const run of [...runs].sort((a, b) => String(a.decision_ts).localeCompare(String(b.decision_ts)))) {
    if (!run?.decision_ts) continue;
    const date = String(run.decision_ts).slice(0, 10);
    const members: Record<CouncilMember, number | null> = { deepseek: null, claude: null, codex: null };
    for (const f of byRun.get(run.id) ?? []) {
      const member = councilMemberOf(f.model_requested);
      const score = num(f.final_score);
      if (member && score != null) members[member] = score;
    }
    const all = [members.deepseek, members.claude, members.codex].filter((v): v is number => v != null);
    const stored = num(run.consensus_score);
    byDay.set(date, {
      date,
      council: stored ?? (all.length === 3 ? median(all) : null),
      council_deepseek: members.deepseek, council_claude: members.claude, council_codex: members.codex,
      council_runs: (byDay.get(date)?.council_runs ?? 0) + 1,
    });
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Attach council days to research score points; a council day with no research point still gets a (null-score) point. */
export function mergeCouncilPoints(points: ScorePoint[], council: ReturnType<typeof toCouncilPoints>): ScorePoint[] {
  const byDate = new Map(points.map((p) => [p.date, { ...p }]));
  for (const c of council) {
    const base = byDate.get(c.date) ?? {
      date: c.date, analyst: null, fundamental: null, technical: null, sentiment: null, macro: null, insider: null,
      direction: null, conviction: null, score_source: null, scoring_version: null, runs: 0,
    };
    byDate.set(c.date, { ...base, council: c.council, council_deepseek: c.council_deepseek, council_claude: c.council_claude, council_codex: c.council_codex, council_runs: c.council_runs });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface CouncilObservationRunRow { id: string; observation_id: number | string | null; status: string; consensus_score: number | string | null }
export type CouncilObservationScores = { council: number | null; deepseek: number | null; claude: number | null; codex: number | null };

/** Council scores keyed by the exact decision observation they scored (stored forecasts; same median rule as toCouncilPoints). */
export function councilByObservation(runs: CouncilObservationRunRow[], forecasts: CouncilForecastRow[]): Map<number, CouncilObservationScores> {
  const byRun = new Map<string, CouncilForecastRow[]>();
  for (const f of forecasts) { const l = byRun.get(f.run_id) ?? []; l.push(f); byRun.set(f.run_id, l); }
  const out = new Map<number, CouncilObservationScores>();
  for (const run of runs) {
    const obs = Number(run.observation_id);
    if (!Number.isFinite(obs)) continue;
    const members: Record<CouncilMember, number | null> = { deepseek: null, claude: null, codex: null };
    for (const f of byRun.get(run.id) ?? []) {
      const member = councilMemberOf(f.model_requested);
      const score = num(f.final_score);
      if (member && score != null) members[member] = score;
    }
    const all = [members.deepseek, members.claude, members.codex].filter((v): v is number => v != null);
    out.set(obs, { council: num(run.consensus_score) ?? (all.length === 3 ? median(all) : null), ...members });
  }
  return out;
}
