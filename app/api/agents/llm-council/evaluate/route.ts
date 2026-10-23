import { councilVersionedSeriesKey } from "@/lib/llm-council/core";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { buildCouncilIcCell, COUNCIL_HORIZONS, equalWeightCouncilBlend, medianScore, type CouncilLabelPoint } from "@/lib/llm-council/core";
import { COUNCIL_ALL_RESEARCH_COHORT_KEY, COUNCIL_COHORT_KEY, isNearThresholdEntryLong } from "@/lib/llm-council/cohort";
import { availabilityAlignedLabel, AVAILABILITY_LABEL_VERSION } from "@/lib/llm-council/availability-label";
import { benchmarkSymbolFor } from "@/lib/data/benchmark-registry";
import { loadStoredResearchBenchmark } from "@/lib/analytics/benchmark-history";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const PAGE = 500;

/**
 * Two cohorts, both evaluated every night. `all_research_v1` = every research symbol scored once per session.
 * `near_threshold_entry_long_v1` = the original predeclared slice: runs tagged near-threshold plus the early runs that
 * only ever covered it (their observation must also satisfy the near-threshold rule).
 */
function runInCohort(cohortKey: string, run: any): boolean {
  const key = run?.config_snapshot?.cohort_key;
  if (cohortKey === COUNCIL_ALL_RESEARCH_COHORT_KEY) return key === COUNCIL_ALL_RESEARCH_COHORT_KEY;
  return key === COUNCIL_COHORT_KEY || (key === COUNCIL_ALL_RESEARCH_COHORT_KEY && run?.config_snapshot?.near_threshold_entry_long === true);
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const modelHistory: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await svc.from("llm_council_model_forecasts")
      .select("model_requested,execution_source,llm_council_runs!inner(market,config_snapshot)")
      .order("created_at", { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) return NextResponse.json({ error: "Could not load council model history" }, { status: 500 });
    modelHistory.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  const batchId = randomUUID();
  const inserted: Array<{ market: string; horizon: number; series: number }> = [];

  for (const market of ["us", "india"] as const) {
    for (const cohortKey of [COUNCIL_COHORT_KEY, COUNCIL_ALL_RESEARCH_COHORT_KEY]) {
    for (const horizon of COUNCIL_HORIZONS) {
      const pointsBySeries = new Map<string, CouncilLabelPoint[]>();
      pointsBySeries.set("composite:median", []);
      pointsBySeries.set("deterministic:analyst_score_paired", []);
      pointsBySeries.set("blend:equal_weight_50_50_paired", []);
      for (const entry of modelHistory) {
        const run = Array.isArray(entry.llm_council_runs) ? entry.llm_council_runs[0] : entry.llm_council_runs;
        if (run?.market !== market || !runInCohort(cohortKey, run) || entry.execution_source === "subscription" || typeof entry.model_requested !== "string") continue;
        pointsBySeries.set(`model:${entry.model_requested}:independent`, []);
        pointsBySeries.set(`model:${entry.model_requested}:debated`, []);
      }
      for (let offset = 0; ; offset += PAGE) {
        const { data: labels, error } = await svc.from("observation_labels")
          .select("observation_id,horizon_days,benchmark_neutral_return,fwd_return,decision_observations!inner(id,ts,symbol,market,analyst_score,score_threshold,entry_eligible,direction,decision_context,discovery_source)")
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
          if (cohortKey === COUNCIL_COHORT_KEY && !isNearThresholdEntryLong(obs)) continue;
          eligible.push({ obs, outcome: Number(outcome) });
        }
        for (let start = 0; start < eligible.length; start += 100) {
          const chunk = eligible.slice(start, start + 100);
          const obsIds = chunk.map((x) => Number(x.obs.id));
          const { data: runs, error: runError } = await svc.from("llm_council_runs")
            .select("id,observation_id,market,consensus_score,status,config_snapshot,prompt_version")
            .in("observation_id", obsIds).in("status", ["completed", "partial", "failed"]);
          if (runError) return NextResponse.json({ error: `Could not read council runs for ${market}` }, { status: 500 });
          if (!runs?.length) continue;
          const cohortRuns = (runs as any[]).filter((run) => runInCohort(cohortKey, run));
          if (!cohortRuns.length) continue;
          const runByObs = new Map(cohortRuns.map((run) => [Number(run.observation_id), run]));
          const { data: forecasts, error: forecastError } = await svc.from("llm_council_model_forecasts")
            .select("run_id,model_requested,model_used,initial_score,final_score,status,execution_source")
            .in("run_id", cohortRuns.map((run) => run.id)).eq("status", "completed");
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
            const runForecasts = forecastsByRun.get(run.id) ?? [];
            const apiForecasts = runForecasts.filter((forecast) => forecast.execution_source !== "subscription");
            const hybrid = run.config_snapshot?.execution_mode === "hybrid";
            const comparisonScore = hybrid
              ? medianScore(apiForecasts.map((forecast) => Number(forecast.final_score)).filter(Number.isFinite))
              : run.consensus_score == null ? null : Number(run.consensus_score);
            const compositeSeriesKey = hybrid ? "composite:api_members_median" : "composite:median";
            const addPoint = (baseKey: string, score: unknown) => {
              const key = councilVersionedSeriesKey(baseKey, run);
              const value = Number(score);
              if (!Number.isFinite(value)) return;
              const list = pointsBySeries.get(key) ?? [];
              list.push({ market, symbol: item.obs.symbol, ts: item.obs.ts, score: value, benchmarkNeutralReturn: item.outcome });
              pointsBySeries.set(key, list);
            };
            if (comparisonScore != null) addPoint(compositeSeriesKey, comparisonScore);
            // Compare the deterministic baseline and a predeclared 50/50 blend
            // only on the exact same run+label sample as the council composite.
            // This is measurement-only; no fitted blend weight or money-path read.
            if (comparisonScore != null) {
              const analystScore = item.obs.analyst_score == null ? null : Number(item.obs.analyst_score);
              if (analystScore != null && Number.isFinite(analystScore)) {
                addPoint("deterministic:analyst_score_paired", analystScore);
                const blend = equalWeightCouncilBlend(analystScore, comparisonScore);
                if (blend != null) addPoint("blend:equal_weight_50_50_paired", blend);
              }
            }
            for (const forecast of apiForecasts) {
              addPoint(`model:${forecast.model_used ?? forecast.model_requested}:independent`, forecast.initial_score);
              addPoint(`model:${forecast.model_used ?? forecast.model_requested}:debated`, forecast.final_score);
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
          cohort_key: cohortKey,
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
  }

  // Subscription results arrive after the research observation. Give them a
  // separate, availability-aligned label: first regular close strictly after
  // each submitted forecast, then h complete matched closes beyond it.
  const delayed: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await svc.from("llm_council_model_forecasts")
      .select("run_id,model_requested,model_used,initial_score,final_score,status,execution_source,available_at,llm_council_runs!inner(id,market,symbol,status,completed_at,consensus_score,input_snapshot,config_snapshot)")
      .eq("execution_source", "subscription").eq("status", "completed")
      .order("available_at", { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) return NextResponse.json({ error: "Could not load delayed subscription forecasts" }, { status: 500 });
    delayed.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  const delayedRuns = new Map<string, any>();
  for (const row of delayed) {
    const run = Array.isArray(row.llm_council_runs) ? row.llm_council_runs[0] : row.llm_council_runs;
    if (!run || !["completed", "partial"].includes(run.status) || !["subscription", "hybrid"].includes(run.config_snapshot?.execution_mode)) continue;
    delayedRuns.set(run.id, run);
  }
  const availabilityCells: Array<{ market: string; horizon: number; series: number }> = [];
  for (const market of ["us", "india"] as const) {
    const marketRows = delayed.flatMap((row) => {
      const run = Array.isArray(row.llm_council_runs) ? row.llm_council_runs[0] : row.llm_council_runs;
      return run?.market === market && delayedRuns.has(run.id) ? [{ forecast: row, run }] : [];
    });
    const symbols = [...new Set(marketRows.map(({ run }) => String(run.symbol).toUpperCase()))];
    const earliest = marketRows.reduce((min, row) => Math.min(min, Date.parse(row.forecast.available_at)), Date.now());
    const fromDate = new Date(earliest - 4 * 86_400_000).toISOString().slice(0, 10);
    const markMap = new Map<string, Array<{ date: string; close: number | null }>>();
    for (let symbolStart = 0; symbolStart < symbols.length; symbolStart += 40) {
      const symbolChunk = symbols.slice(symbolStart, symbolStart + 40);
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await svc.from("price_cache").select("symbol,date,close")
          .in("symbol", symbolChunk).gte("date", fromDate).order("date", { ascending: true }).range(offset, offset + PAGE - 1);
        if (error) return NextResponse.json({ error: `Could not load ${market} availability-aligned closes` }, { status: 500 });
        for (const mark of data ?? []) {
          const key = String(mark.symbol).toUpperCase();
          const list = markMap.get(key) ?? [];
          list.push({ date: String(mark.date).slice(0, 10), close: mark.close == null ? null : Number(mark.close) });
          markMap.set(key, list);
        }
        if (!data || data.length < PAGE) break;
      }
    }
    try {
      markMap.set(benchmarkSymbolFor(market, "research"), await loadStoredResearchBenchmark(svc, market, fromDate, new Date().toISOString().slice(0, 10)));
    } catch {
      return NextResponse.json({ error: `Could not load ${market} stored research benchmark` }, { status: 500 });
    }
    for (const horizon of COUNCIL_HORIZONS) {
      const pointMap = new Map<string, CouncilLabelPoint[]>();
      const add = (key: string, symbol: string, session: string, score: unknown, outcome: number) => {
        const value = typeof score === "number" ? score : Number(score);
        if (!Number.isFinite(value) || !Number.isFinite(outcome)) return;
        const points = pointMap.get(key) ?? [];
        points.push({ market, symbol, ts: `${session}T12:00:00.000Z`, score: value, benchmarkNeutralReturn: outcome });
        pointMap.set(key, points);
      };
      const benchmarkMarks = markMap.get(benchmarkSymbolFor(market, "research")) ?? [];
      const compositeSeen = new Set<string>();
      for (const { forecast, run } of marketRows) {
        const symbol = String(run.symbol).toUpperCase();
        const symbolMarks = markMap.get(symbol) ?? [];
        const label = availabilityAlignedLabel({ market, availableAt: forecast.available_at, horizonDays: horizon, symbolMarks, benchmarkMarks });
        const model = String(forecast.model_used ?? forecast.model_requested);
        const prefix = `model:${model}:subscription`;
        const independentKey = councilVersionedSeriesKey(`${prefix}:independent`, run);
        const debatedKey = councilVersionedSeriesKey(`${prefix}:debated`, run);
        pointMap.set(independentKey, pointMap.get(independentKey) ?? []);
        pointMap.set(debatedKey, pointMap.get(debatedKey) ?? []);
        if (label) {
          add(independentKey, symbol, label.entrySession, forecast.initial_score, label.benchmarkNeutralReturn);
          add(debatedKey, symbol, label.entrySession, forecast.final_score, label.benchmarkNeutralReturn);
        }
        if (compositeSeen.has(run.id)) continue;
        compositeSeen.add(run.id);
        const consensusLabel = run.completed_at ? availabilityAlignedLabel({ market, availableAt: run.completed_at, horizonDays: horizon, symbolMarks, benchmarkMarks }) : null;
        for (const baseKey of ["composite:availability_median", "deterministic:availability_paired", "blend:availability_equal_weight_50_50_paired"]) {
          const key = councilVersionedSeriesKey(baseKey, run); pointMap.set(key, pointMap.get(key) ?? []);
        }
        if (consensusLabel && run.consensus_score != null) {
          add(councilVersionedSeriesKey("composite:availability_median", run), symbol, consensusLabel.entrySession, Number(run.consensus_score), consensusLabel.benchmarkNeutralReturn);
          const deterministic = run.input_snapshot?.deterministic_score?.composite;
          if (deterministic != null && Number.isFinite(Number(deterministic))) {
            add(councilVersionedSeriesKey("deterministic:availability_paired", run), symbol, consensusLabel.entrySession, Number(deterministic), consensusLabel.benchmarkNeutralReturn);
            const blend = equalWeightCouncilBlend(Number(deterministic), Number(run.consensus_score));
            if (blend != null) add(councilVersionedSeriesKey("blend:availability_equal_weight_50_50_paired", run), symbol, consensusLabel.entrySession, blend, consensusLabel.benchmarkNeutralReturn);
          }
        }
      }
      const cells = [...pointMap.entries()].map(([key, points]) => {
        const parts = key.split(":");
        return buildCouncilIcCell(market, horizon, key, parts[0] === "model" ? parts[1] : null, points);
      });
      if (cells.length) {
        const { error } = await svc.from("llm_council_ic_runs").insert(cells.map((cell) => ({
          evaluation_batch_id: batchId, market: cell.market, horizon_days: cell.horizonDays,
          series_key: cell.seriesKey, forecast_model: cell.forecastModel,
          cohort_key: "forecast_available_close_v2", observation_count: cell.observationCount,
          qualifying_sessions: cell.qualifyingSessions, independent_windows: Number(cell.independentWindows.toFixed(4)),
          mean_session_rank_ic: cell.meanSessionRankIc, sd_session_rank_ic: cell.sdSessionRankIc,
          t_stat: cell.tStat, classification: cell.classification,
          reason: `${AVAILABILITY_LABEL_VERSION}. ${cell.reason} Subscription labels use price_cache closes strictly after forecast availability and the versioned research benchmark; gross close-to-close price movement, not execution P&L.`,
        })));
        if (error) return NextResponse.json({ error: `Could not persist ${market} availability-aligned IC cells` }, { status: 500 });
      }
      availabilityCells.push({ market, horizon, series: cells.length });
    }
  }
  return NextResponse.json({ batchId, results: inserted, availabilityAligned: availabilityCells, horizons: COUNCIL_HORIZONS, cohorts: [COUNCIL_COHORT_KEY, COUNCIL_ALL_RESEARCH_COHORT_KEY], delayedCohort: "forecast_available_close_v2", shadowOnly: true });
}

// Vercel Cron invokes configured routes with GET. Keep the same secret check
// and evaluation body for manual/internal POST calls and scheduled GET calls.
export const GET = POST;
