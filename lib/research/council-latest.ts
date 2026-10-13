import { councilMemberOf, type CouncilMember } from "@/lib/research/score-history";
import { fetchAllRows } from "@/lib/supabase/paginate";

// Newest LLM-council (shadow) scores per `${symbol}:${market}`, for tables that list the whole research universe
// (the Fundamentals page). Stored forecasts only: this never calls a model.

export type CouncilLatestRow = {
  council_score: number | null;
  council_deepseek: number | null;
  council_claude: number | null;
  council_codex: number | null;
  council_as_of: string;
  council_status: string;
};

type RunRow = { id: string; symbol: string; market: string; decision_ts: string; status: string; consensus_score: number | string | null };
type ForecastRow = { run_id: string; model_requested: string; final_score: number | string | null };

const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Newest run per symbol+market. The composite is the run's stored consensus; a run finalized before its last member returned
 * has no stored consensus, so the deterministic median of all THREE members is used, and only when all three exist
 * (a median of two would invent a council opinion).
 */
export function buildCouncilLatest(runs: RunRow[], forecasts: ForecastRow[]): Map<string, CouncilLatestRow> {
  const newest = new Map<string, RunRow>();
  for (const run of runs) {
    const key = `${run.symbol}:${run.market}`;
    const cur = newest.get(key);
    if (!cur || String(run.decision_ts) > String(cur.decision_ts)) newest.set(key, run);
  }
  const byRun = new Map<string, ForecastRow[]>();
  for (const f of forecasts) { const l = byRun.get(f.run_id) ?? []; l.push(f); byRun.set(f.run_id, l); }
  const out = new Map<string, CouncilLatestRow>();
  for (const [key, run] of newest) {
    const members: Record<CouncilMember, number | null> = { deepseek: null, claude: null, codex: null };
    for (const f of byRun.get(run.id) ?? []) {
      const member = councilMemberOf(f.model_requested);
      const score = num(f.final_score);
      if (member && score != null) members[member] = score;
    }
    const all = [members.deepseek, members.claude, members.codex].filter((v): v is number => v != null).sort((a, b) => a - b);
    out.set(key, {
      council_score: num(run.consensus_score) ?? (all.length === 3 ? all[1] : null),
      council_deepseek: members.deepseek, council_claude: members.claude, council_codex: members.codex,
      council_as_of: run.decision_ts, council_status: run.status,
    });
  }
  return out;
}

export async function loadCouncilLatest(svc: any, sinceDays = 7): Promise<Map<string, CouncilLatestRow>> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const runs = await fetchAllRows((from, to) => svc.from("llm_council_runs").select("id,symbol,market,decision_ts,status,consensus_score")
    .gte("decision_ts", since).order("decision_ts", { ascending: true }).order("id", { ascending: true }).range(from, to), "council runs for universe") as RunRow[];
  // Only the newest run per symbol+market needs its forecasts.
  const newestRun = new Map<string, RunRow>();
  for (const r of runs) {
    const k = `${r.symbol}:${r.market}`;
    const cur = newestRun.get(k);
    if (!cur || String(r.decision_ts) > String(cur.decision_ts)) newestRun.set(k, r);
  }
  const newestIds = [...newestRun.values()].map((r) => r.id);
  const forecasts: ForecastRow[] = [];
  for (let i = 0; i < newestIds.length; i += 200) {
    const { data, error } = await svc.from("llm_council_model_forecasts").select("run_id,model_requested,final_score")
      .in("run_id", newestIds.slice(i, i + 200)).eq("status", "completed");
    if (error) throw new Error(`council forecasts query failed: ${error.message}`);
    forecasts.push(...((data ?? []) as ForecastRow[]));
  }
  return buildCouncilLatest(runs, forecasts);
}
