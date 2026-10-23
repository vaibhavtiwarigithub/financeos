// Research gate for the leveraged-sleeve PAPER doors ("routed" design).
//
// Research scores SOXL/TQQQ/SQQQ/SOXS like any other symbol, but the generic
// PaperTrader still refuses them (symbol-policy blanket block, unchanged) so they
// never enter the 8-name alpha book or capital rotation. The dedicated doors are the
// only way they trade. Legacy callers require a fresh deterministic long above
// threshold. Paper intraday-v3 instead requires fresh session-validated research
// context plus its independently confirmed current-session setup; yesterday's
// direction/score is not an intraday entry trigger. Liquidity, stop geometry,
// combined 5% sleeve, cash and position limits still apply.
export const RESEARCH_GATE_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

export interface ResearchSignalRow {
  id: string;
  direction: string | null;
  analyst_score: number | string | null;
  score_source: string | null;
  created_at: string | null;
  status: string | null;
  session_validated: boolean | null;
}

export type ResearchGate =
  | { ok: true; signalId: string; score: number; ageDays: number }
  | { ok: false; reason: string };

export function evaluateLeveragedResearchGate(
  signal: ResearchSignalRow | null,
  input: { threshold: number; now: number; intradayQualified?: boolean },
): ResearchGate {
  if (!signal) return { ok: false, reason: "no_research_signal" };
  if (!Number.isFinite(input.threshold) || input.threshold <= 0) return { ok: false, reason: "invalid_threshold" };
  if (signal.score_source !== "deterministic_v1") return { ok: false, reason: "signal_not_deterministic" };
  if (signal.session_validated !== true) return { ok: false, reason: "signal_not_session_validated" };
  if (!input.intradayQualified && signal.direction !== "long") return { ok: false, reason: "signal_not_long" };
  const score = Number(signal.analyst_score);
  if (signal.analyst_score == null || !Number.isFinite(score)) return { ok: false, reason: "signal_score_missing" };
  if (!input.intradayQualified && score < input.threshold) return { ok: false, reason: "signal_below_threshold" };
  const created = Date.parse(signal.created_at ?? "");
  if (!Number.isFinite(created) || created > input.now) return { ok: false, reason: "signal_time_invalid" };
  if (input.now - created > RESEARCH_GATE_MAX_AGE_MS) return { ok: false, reason: "signal_stale" };
  return { ok: true, signalId: signal.id, score, ageDays: (input.now - created) / 86_400_000 };
}

/** Latest signal for the symbol regardless of status: a newer neutral/short verdict must supersede an older long. */
export async function loadLatestResearchSignal(supabase: any, symbol: string): Promise<{ signal: ResearchSignalRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from("agent_signals")
    .select("id,direction,analyst_score,score_source,created_at,status,session_validated")
    .eq("symbol", symbol).eq("market", "us")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return { signal: null, error: error.message };
  return { signal: (data as ResearchSignalRow | null) ?? null, error: null };
}
