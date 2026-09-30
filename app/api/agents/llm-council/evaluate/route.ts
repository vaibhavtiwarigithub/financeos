import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { isEntryCandidateLong } from "@/lib/learning/entry-cohort";
import { buildCouncilIcCell, COUNCIL_HORIZONS, type CouncilLabelPoint } from "@/lib/llm-council/core";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const PAGE = 500;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const modelHistory: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await svc.from("llm_council_model_forecasts")
      .select("model_requested,llm_council_runs!inner(market)")
      .order("created_at", { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) return NextResponse.json({ error: "Could not load council model history" }, { status: 500 });
    modelHistory.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  const batchId = randomUUID();
  const inserted: Array<{ market: string; horizon: number; series: number }> = [];

  for (const market of ["us", "india"] as const) {
    for (const horizon of COUNCIL_HORIZONS) {
      const pointsBySeries = new Map<string, CouncilLabelPoint[]>();
      pointsBySeries.set("composite:median", []);
      for (const entry of modelHistory) {
        const run = Array.isArray(entry.llm_council_runs) ? entry.llm_council_runs[0] : entry.llm_council_runs;
        if (run?.market !== market || typeof entry.model_requested !== "string") continue;
        pointsBySeries.set(`model:${entry.model_requested}:independent`, []);
        pointsBySeries.set(`model:${entry.model_requested}:debated`, []);
      }
      for (let offset = 0; ; offset += PAGE) {
        const { data: labels, error } = await svc.from("observation_labels")
          .select("observation_id,horizon_days,benchmark_neutral_return,fwd_return,decision_observations!inner(id,ts,symbol,market,entry_eligible,direction,decision_context,discovery_source)")
          .eq("horizon_days", horizon).eq("decision_observations.market", market)
          .order("observation_id", { ascending: true }).range(offset, offset + PAGE - 1);
        if (error) return NextResponse.json({ error: `Could not load matured labels for ${market} h${horizon}` }, { status: 500 });
        const rows = (labels ?? []) as any[];
        const eligible: Array<{ obs: any; outcome: number }> = [];
        for (const row of rows) {
          const obs = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
          // Council IC is explicitly benchmark-neutral. Never silently mix
          // raw forward returns into that series when the neutral label is
          // unavailable; such rows are incomplete for this evaluator.
          const outcome = row.benchmark_neutral_return;
          if (!obs || outcome == null || !Number.isFinite(Number(outcome))) continue;
          if (!isEntryCandidateLong({ entryEligible: obs.entry_eligible, direction: obs.direction, decisionContext: obs.decision_context, discoverySource: obs.discovery_source })) continue;
          eligible.push({ obs, outcome: Number(outcome) });
        }
        for (let start = 0; start < eligible.length; start += 100) {
          const chunk = eligible.slice(start, start + 100);
          const obsIds = chunk.map((x) => Number(x.obs.id));
          const { data: runs, error: runError } = await svc.from("llm_council_runs")
            .select("id,observation_id,market,consensus_score,status")
            .in("observation_id", obsIds).in("status", ["completed", "partial", "failed"]);
          if (runError) return NextResponse.json({ error: `Could not read council runs for ${market}` }, { status: 500 });
          if (!runs?.length) continue;
          const runByObs = new Map((runs as any[]).map((run) => [Number(run.observation_id), run]));
          const { data: forecasts, error: forecastError } = await svc.from("llm_council_model_forecasts")
            .select("run_id,model_requested,initial_score,final_score,status")
            .in("run_id", (runs as any[]).map((run) => run.id)).eq("status", "completed");
          if (forecastError) return NextResponse.json({ error: `Could not read council forecasts for ${market}` }, { status: 500 });
          const forecastsByRun = new Map<string, any[]>();
          for (const forecast of (forecasts ?? []) as any[]) {
            const list = forecastsByRun.get(forecast.run_id) ?? [];
            list.push(forecast);
            forecastsByRun.set(forecast.run_id, list);
          }
          for (const item of chunk) {
            const run: any = runByObs.get(Number(item.obs.id));
            if (!run) continue;
            const addPoint = (key: string, score: unknown) => {
              const value = Number(score);
              if (!Number.isFinite(value)) return;
              const list = pointsBySeries.get(key) ?? [];
              list.push({ market, symbol: item.obs.symbol, ts: item.obs.ts, score: value, benchmarkNeutralReturn: item.outcome });
              pointsBySeries.set(key, list);
            };
            if (run.consensus_score != null) addPoint("composite:median", run.consensus_score);
            for (const forecast of forecastsByRun.get(run.id) ?? []) {
              addPoint(`model:${forecast.model_requested}:independent`, forecast.initial_score);
              addPoint(`model:${forecast.model_requested}:debated`, forecast.final_score);
            }
          }
        }
        if (rows.length < PAGE) break;
      }
      const cells = [...pointsBySeries.entries()].map(([seriesKey, points]) => {
        const model = seriesKey.startsWith("model:") ? seriesKey.split(":")[1] : null;
        return buildCouncilIcCell(market, horizon, seriesKey, model, points);
      });
      if (cells.length) {
        const { error: writeError } = await svc.from("llm_council_ic_runs").insert(cells.map((cell) => ({
          evaluation_batch_id: batchId,
          market: cell.market,
          horizon_days: cell.horizonDays,
          series_key: cell.seriesKey,
          forecast_model: cell.forecastModel,
          cohort_key: "eligible_long_entry_candidate",
          observation_count: cell.observationCount,
          qualifying_sessions: cell.qualifyingSessions,
          independent_windows: Number(cell.independentWindows.toFixed(4)),
          mean_session_rank_ic: cell.meanSessionRankIc,
          sd_session_rank_ic: cell.sdSessionRankIc,
          t_stat: cell.tStat,
          classification: cell.classification,
          reason: cell.reason,
        })));
        if (writeError) return NextResponse.json({ error: `Could not persist ${market} h${horizon} IC cells` }, { status: 500 });
      }
      inserted.push({ market, horizon, series: cells.length });
    }
  }
  return NextResponse.json({ batchId, results: inserted, horizons: COUNCIL_HORIZONS, cohort: "eligible long entry candidates", shadowOnly: true });
}
