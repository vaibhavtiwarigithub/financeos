import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { COUNCIL_HORIZONS, medianScore } from "@/lib/llm-council/core";
import { evaluatePairs, pairEventScores, type ObservationRow } from "@/lib/llm-events/evaluate";
import { CURRENT_LABEL_CONTRACT_VERSION } from "@/lib/learning/label-contract";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Measure-only nightly evaluation of the India LLM event score against matured benchmark-neutral labels. Writes llm_event_ic_runs.
// Council and composite are scored on the SAME paired observations so the partial IC and redundancy numbers are like for like.

const CHUNK = 100;

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const batchId = randomUUID();

  const scores = await fetchAllRows((from, to) => svc.from("llm_event_scores").select("id,symbol,as_of,score")
    .order("id", { ascending: true }).range(from, to), "llm event scores") as any[];
  if (!scores.length) return NextResponse.json({ ok: true, skipped: "no_event_scores_yet", shadowOnly: true });
  const scoreRows = scores.map((s) => ({ symbol: String(s.symbol), as_of: String(s.as_of), score: Number(s.score) }));
  const earliest = scoreRows.reduce((m, s) => (s.as_of < m ? s.as_of : m), scoreRows[0].as_of);

  const summary: Array<{ horizon: number; pairs: number; cells: number }> = [];
  for (const horizon of COUNCIL_HORIZONS) {
    const labels = await fetchAllRows((from, to) => svc.from("observation_labels")
      .select("observation_id,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,analyst_score)")
      .eq("horizon_days", horizon).eq("label_contract_version", CURRENT_LABEL_CONTRACT_VERSION).eq("decision_observations.market", "india").gte("decision_observations.ts", earliest)
      .order("observation_id", { ascending: true }).range(from, to), "llm event labels") as any[];

    const eligible: Array<{ id: number; symbol: string; ts: string; analyst: number | null; outcome: number | null }> = [];
    for (const row of labels) {
      const obs = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
      const outcome = row.benchmark_neutral_return;
      if (!obs || outcome == null || !Number.isFinite(Number(outcome))) continue;
      eligible.push({ id: Number(obs.id), symbol: String(obs.symbol).toUpperCase(), ts: String(obs.ts), analyst: obs.analyst_score == null ? null : Number(obs.analyst_score), outcome: Number(outcome) });
    }

    // Council median per observation: stored consensus when present, else the median of completed member forecasts (>= 2 members).
    const councilByObs = new Map<number, number>();
    for (let i = 0; i < eligible.length; i += CHUNK) {
      const ids = eligible.slice(i, i + CHUNK).map((e) => e.id);
      const { data: runs, error } = await svc.from("llm_council_runs").select("id,observation_id,consensus_score,status")
        .in("observation_id", ids).in("status", ["completed", "partial"]);
      if (error) return NextResponse.json({ ok: false, error: "could not read council runs" }, { status: 500 });
      const runIds = (runs ?? []).map((r: any) => r.id);
      const byRun = new Map<string, number[]>();
      if (runIds.length) {
        const { data: fc, error: fe } = await svc.from("llm_council_model_forecasts").select("run_id,final_score").in("run_id", runIds).eq("status", "completed");
        if (fe) return NextResponse.json({ ok: false, error: "could not read council forecasts" }, { status: 500 });
        for (const f of fc ?? []) { const l = byRun.get((f as any).run_id) ?? []; l.push(Number((f as any).final_score)); byRun.set((f as any).run_id, l); }
      }
      for (const run of (runs ?? []) as any[]) {
        const members = byRun.get(run.id) ?? [];
        const median = run.consensus_score != null ? Number(run.consensus_score) : members.length >= 2 ? medianScore(members) : null;
        if (median != null && Number.isFinite(median)) councilByObs.set(Number(run.observation_id), median);
      }
    }

    const observations: ObservationRow[] = eligible.map((e) => ({ symbol: e.symbol, ts: e.ts, council: councilByObs.get(e.id) ?? null, analyst: e.analyst, outcome: e.outcome }));
    const paired = pairEventScores(observations, scoreRows);
    const cells = evaluatePairs(horizon, paired);
    const { error } = await svc.from("llm_event_ic_runs").insert(cells.map((c) => ({
      evaluation_batch_id: batchId, horizon_days: c.horizonDays, series_key: c.seriesKey, observation_count: c.observationCount,
      qualifying_sessions: c.qualifyingSessions, independent_windows: Number(c.independentWindows.toFixed(4)), mean_session_rank_ic: c.mean,
      sd_session_rank_ic: c.sd, t_stat: c.tStat, classification: c.classification, reason: c.reason, paired_observations: paired.length,
    })));
    if (error) return NextResponse.json({ ok: false, error: `could not persist h${horizon} cells: ${error.message}` }, { status: 500 });
    summary.push({ horizon, pairs: paired.length, cells: cells.length });
  }

  await svc.from("agent_runs").insert({
    agent_type: "llm_events_evaluate", status: "done", market: "india", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${summary.map((s) => `h${s.horizon}=${s.pairs} pairs`).join(", ")}; behavior changed=false`,
  });
  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, batchId, summary });
}

export const POST = GET;
