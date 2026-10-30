import { fetchAllRows } from "@/lib/supabase/paginate";
import { loadLabeledDataset } from "@/lib/learning/dataset";

export const FORWARD_PROMOTION_WINDOWS = 20;
const VALID_HORIZONS = new Set([2, 5, 10, 20]);

export interface ForwardPair {
  session: string;
  timestamp?: string;
  symbol: string;
  candidateEnter: boolean;
  baselineEnter: boolean;
  benchmarkNeutralReturn: number;
}

export interface ForwardPromotionEvidence {
  status: "insufficient_evidence" | "passed" | "failed";
  reason: string;
  horizonSessions: number;
  observations: number;
  qualifyingSessions: number;
  effectiveWindows: number;
  windowsRequired: number;
  candidateMeanNetReturn: number | null;
  baselineMeanNetReturn: number | null;
  pairedDifferenceMean: number | null;
  pairedDifferenceT: number | null;
  pairedDifferenceCiLower95: number | null;
  evaluationStart: string | null;
  evaluationEnd: string | null;
  method: "matched_shadow_decisions_nonoverlap_horizon_blocks_v1";
}

/** Pure evaluator. Each block contributes its last market session, so labels
 * separated by the declared horizon do not overlap. It grades the challenger
 * and incumbent on the same observations. Existing labels are already net of
 * the project cost convention; deducting costs again would double count. */
export function evaluateForwardPairs(
  pairs: ForwardPair[],
  horizonSessions: number,
): ForwardPromotionEvidence {
  const base = (status: ForwardPromotionEvidence["status"], reason: string, extra: Partial<ForwardPromotionEvidence> = {}): ForwardPromotionEvidence => ({
    status, reason, horizonSessions, observations: pairs.length, qualifyingSessions: 0,
    effectiveWindows: 0, windowsRequired: FORWARD_PROMOTION_WINDOWS,
    candidateMeanNetReturn: null, baselineMeanNetReturn: null,
    pairedDifferenceMean: null, pairedDifferenceT: null,
    pairedDifferenceCiLower95: null, evaluationStart: null, evaluationEnd: null,
    method: "matched_shadow_decisions_nonoverlap_horizon_blocks_v1", ...extra,
  });
  if (!VALID_HORIZONS.has(horizonSessions)) return base("failed", "unsupported_horizon");

  // Keep only the first deterministic observation per symbol/session. This
  // avoids one heavily researched ticker or duplicate same-day runs dominating.
  const firstBySymbolSession = new Map<string, ForwardPair>();
  for (const row of [...pairs].sort((a, b) => a.session.localeCompare(b.session) || String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")) || a.symbol.localeCompare(b.symbol))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.session) || !row.symbol || !Number.isFinite(row.benchmarkNeutralReturn)) continue;
    const key = `${row.symbol}|${row.session}`;
    if (!firstBySymbolSession.has(key)) firstBySymbolSession.set(key, row);
  }
  const bySession = new Map<string, ForwardPair[]>();
  for (const row of firstBySymbolSession.values()) {
    const rows = bySession.get(row.session) ?? [];
    rows.push(row);
    bySession.set(row.session, rows);
  }
  const dates = [...bySession.keys()].sort();
  const windows = Math.floor(dates.length / horizonSessions);
  if (windows < FORWARD_PROMOTION_WINDOWS) {
    return base("insufficient_evidence", `need_${FORWARD_PROMOTION_WINDOWS}_nonoverlapping_windows`, {
      qualifyingSessions: dates.length, effectiveWindows: windows,
      evaluationStart: dates[0] ?? null, evaluationEnd: dates.at(-1) ?? null,
    });
  }

  // Freeze exactly the first 20 independent windows. A challenger is evaluated
  // once; repeated peeking at later returns cannot turn a failed test into a pass.
  const candidate: number[] = [];
  const baseline: number[] = [];
  const paired: number[] = [];
  const sampledDates: string[] = [];
  for (let block = 0; block < FORWARD_PROMOTION_WINDOWS; block++) {
    const date = dates[(block + 1) * horizonSessions - 1];
    const rows = bySession.get(date) ?? [];
    if (!rows.length) continue;
    const candidateValues = rows.map((r) => r.candidateEnter ? r.benchmarkNeutralReturn : 0);
    const baselineValues = rows.map((r) => r.baselineEnter ? r.benchmarkNeutralReturn : 0);
    const c = candidateValues.reduce((sum, value) => sum + value, 0) / candidateValues.length;
    const b = baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length;
    candidate.push(c); baseline.push(b); paired.push(c - b); sampledDates.push(date);
  }
  if (paired.length !== FORWARD_PROMOTION_WINDOWS) {
    return base("insufficient_evidence", "incomplete_fixed_window_cohort", {
      qualifyingSessions: dates.length, effectiveWindows: paired.length,
      evaluationStart: sampledDates[0] ?? null, evaluationEnd: sampledDates.at(-1) ?? null,
    });
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const pairedMean = mean(paired);
  const variance = paired.reduce((sum, value) => sum + (value - pairedMean) ** 2, 0) / (paired.length - 1);
  const se = Math.sqrt(variance / paired.length);
  const t = se === 0 ? (pairedMean > 0 ? 1_000_000 : pairedMean < 0 ? -1_000_000 : 0) : pairedMean / se;
  const ciLow = pairedMean - 2.093 * se; // t(19), two-sided 95% lower bound
  const passed = mean(candidate) > 0 && pairedMean > 0 && ciLow > 0 && t >= 2.093;
  return base(passed ? "passed" : "failed", passed ? "forward_gate_passed" : "forward_gate_not_passed", {
    qualifyingSessions: dates.length, effectiveWindows: paired.length,
    candidateMeanNetReturn: mean(candidate), baselineMeanNetReturn: mean(baseline),
    pairedDifferenceMean: pairedMean, pairedDifferenceT: t,
    pairedDifferenceCiLower95: ciLow,
    evaluationStart: sampledDates[0] ?? null, evaluationEnd: sampledDates.at(-1) ?? null,
  });
}

export async function evaluateShadowCandidate(supabase: any, input: { market: "us" | "india"; candidateId: number }): Promise<ForwardPromotionEvidence> {
  const { data: version, error: versionError } = await supabase.from("strategy_versions")
    .select("id,market,state,created_at,genome,validation_experiment_id")
    .eq("id", input.candidateId).eq("market", input.market).maybeSingle();
  if (versionError) throw new Error(`strategy candidate read failed: ${versionError.message}`);
  if (!version || version.state !== "shadow_paper") throw new Error("candidate_not_in_forward_shadow");

  const { data: validation, error: validationError } = await supabase.from("validation_experiments")
    .select("horizon_days,passed").eq("id", version.validation_experiment_id).eq("challenger_id", version.id).maybeSingle();
  if (validationError) throw new Error(`strategy validation evidence read failed: ${validationError.message}`);
  if (!validation?.passed) throw new Error("historical_validation_not_passed");
  const genomeHorizon = Number(version.genome?.horizon_days);
  const horizon = VALID_HORIZONS.has(genomeHorizon) ? genomeHorizon : Number(validation.horizon_days);
  if (!VALID_HORIZONS.has(horizon)) throw new Error("candidate_horizon_missing_or_unsupported");

  const shadowRows = await fetchAllRows((from, to) => supabase.from("shadow_decisions")
    .select("observation_id,market,symbol,ts,would_enter")
    .eq("market", input.market).eq("policy_version_id", input.candidateId)
    .gte("ts", version.created_at).order("ts", { ascending: true }).range(from, to), "strategy shadow decisions");
  if (!shadowRows.length) return evaluateForwardPairs([], horizon);
  const labeled = await loadLabeledDataset(supabase, input.market, horizon as 2 | 5 | 10 | 20, { fromTimestamp: version.created_at });
  const labels = new Map(labeled.filter((row) => row.benchmark_neutral_return != null).map((row) => [Number(row.id), row]));
  const pairs: ForwardPair[] = [];
  for (const shadow of shadowRows as any[]) {
    const observation = labels.get(Number(shadow.observation_id));
    if (!observation || observation.market !== input.market || observation.benchmark_neutral_return == null) continue;
    pairs.push({
      session: observation.ts.slice(0, 10), symbol: observation.symbol,
      timestamp: observation.ts,
      candidateEnter: shadow.would_enter === true,
      baselineEnter: observation.entry_eligible === true,
      benchmarkNeutralReturn: observation.benchmark_neutral_return,
    });
  }
  return evaluateForwardPairs(pairs, horizon);
}
