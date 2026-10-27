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
import { fetchAllRows } from "@/lib/supabase/paginate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const receipt = await svc.from("agent_runs").insert({
    agent_type: "llm_council_evaluate", status: "running", symbols: [],
    trigger_source: "scheduled", signals_written: 0,
    tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: "Council IC evaluation started; both markets; shadow only; no inference.",
  }).select("id").single();
  if (receipt.error || !receipt.data?.id) return NextResponse.json({ error: "Could not record council evaluator start" }, { status: 500 });
  const batchId = randomUUID();
  let publishedBatch: string | null = null;
  let publicationAttempted = false;
  let phase = "model history";
  try {
  const modelHistory = await fetchAllRows<any>((from, to) => svc.from("llm_council_model_forecasts")
      .select("model_requested,execution_source,llm_council_runs!inner(market,config_snapshot,created_at,prompt_version)")
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to), "council model history");
  // Only council-linked observations can contribute. Read these ledgers once,
  // not once per historical-label page, cohort and horizon.
  phase = "terminal runs";
  const terminalRuns = await fetchAllRows<any>((from, to) => svc.from("llm_council_runs")
    .select("id,observation_id,market,consensus_score,status,config_snapshot,prompt_version,created_at")
    .in("status", ["completed", "partial", "failed"]).order("id", { ascending: true }).range(from, to), "council runs");
  phase = "completed forecasts";
  const completedForecasts = await fetchAllRows<any>((from, to) => svc.from("llm_council_model_forecasts")
    .select("run_id,model_requested,model_used,initial_score,final_score,status,execution_source")
    .eq("status", "completed").order("id", { ascending: true }).range(from, to), "council forecasts");
  const forecastsByRun = new Map<string, any[]>();
  for (const forecast of completedForecasts) {
    const list = forecastsByRun.get(forecast.run_id) ?? [];
    list.push(forecast);
    forecastsByRun.set(forecast.run_id, list);
  }
  const apiModelIds=(id:string)=>(forecastsByRun.get(id)??[])
    .filter(row=>row.execution_source!=="subscription").map(row=>row.model_used??row.model_requested);
  // Include recorded fallbacks when deciding whether the composite depends on Flash.
  for(const run of terminalRuns) run.api_model_ids=apiModelIds(run.id);
  // A single insert publishes all cells atomically. A failed later read must
  // never make an incomplete batch look like the newest successful evaluation.
  const pendingCells: any[] = [];
  const inserted: Array<{ market: string; horizon: number; series: number }> = [];

  for (const market of ["us", "india"] as const) {
    phase = `${market} linked observation labels`;
    const marketRuns = terminalRuns.filter((run) => run.market === market);
    const obsIds = [...new Set(marketRuns.map((run) => run.observation_id).filter((id) => id != null))];
    const marketLabels: any[] = [];
    for (let start = 0; start < obsIds.length; start += 100) {
      const chunk = obsIds.slice(start, start + 100);
      marketLabels.push(...await fetchAllRows<any>((from, to) => svc.from("observation_labels")
        .select("observation_id,horizon_days,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,analyst_score,score_threshold,entry_eligible,direction,decision_context,discovery_source)")
        .in("observation_id", chunk).in("horizon_days", [...COUNCIL_HORIZONS])
        .eq("decision_observations.market", market)
        .order("observation_id", { ascending: true }).order("horizon_days", { ascending: true }).range(from, to), `${market} council labels`));
    }
    for (const cohortKey of [COUNCIL_COHORT_KEY, COUNCIL_ALL_RESEARCH_COHORT_KEY]) {
    const cohortRuns = marketRuns.filter((run) => runInCohort(cohortKey, run));
    const runByObs = new Map(cohortRuns.map((run) => [Number(run.observation_id), run]));
    for (const horizon of COUNCIL_HORIZONS) {
      const pointsBySeries = new Map<string, CouncilLabelPoint[]>();
      for(const run of cohortRuns.length ? cohortRuns : [null]) {
        const composite=run?.config_snapshot?.execution_mode==="hybrid" ? "composite:api_members_median" : "composite:median";
        for(const key of [composite,"deterministic:analyst_score_paired","blend:equal_weight_50_50_paired"])
          pointsBySeries.set(councilVersionedSeriesKey(key,run),[]);
      }
      for (const entry of modelHistory) {
        const run = Array.isArray(entry.llm_council_runs) ? entry.llm_council_runs[0] : entry.llm_council_runs;
        if (run?.market !== market || !runInCohort(cohortKey, run) || entry.execution_source === "subscription" || typeof entry.model_requested !== "string") continue;
        pointsBySeries.set(councilVersionedSeriesKey(`model:${entry.model_requested}:independent`,run), []);
        pointsBySeries.set(councilVersionedSeriesKey(`model:${entry.model_requested}:debated`,run), []);
      }
        const rows = marketLabels.filter((row) => row.horizon_days === horizon);
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
          for (const item of eligible) {
            const run: any = runByObs.get(Number(item.obs.id));
            if (!run) continue;
            const runForecasts = forecastsByRun.get(run.id) ?? [];
            const apiForecasts = runForecasts.filter((forecast) => forecast.execution_source !== "subscription");
            const hybrid = run.config_snapshot?.execution_mode === "hybrid";
            const comparisonScore = hybrid
              ? medianScore(apiForecasts.filter((forecast) => forecast.final_score != null).map((forecast) => Number(forecast.final_score)).filter(Number.isFinite))
              : run.consensus_score == null ? null : Number(run.consensus_score);
            const compositeSeriesKey = hybrid ? "composite:api_members_median" : "composite:median";
            const addPoint = (baseKey: string, score: unknown) => {
              if (score == null) return;
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
      const cells = [...pointsBySeries.entries()].map(([seriesKey, points]) => {
        const model = seriesKey.startsWith("model:") ? seriesKey.split(":")[1] : null;
        return buildCouncilIcCell(market, horizon, seriesKey, model, points);
      });
      if (cells.length) {
        pendingCells.push(...cells.map((cell) => ({
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
      }
      inserted.push({ market, horizon, series: cells.length });
    }
    }
  }

  // Subscription results arrive after the research observation. Give them a
  // separate, availability-aligned label: first regular close strictly after
  // each submitted forecast, then h complete matched closes beyond it.
  phase = "subscription forecasts";
  const delayed = await fetchAllRows<any>((from, to) => svc.from("llm_council_model_forecasts")
      .select("run_id,model_requested,model_used,initial_score,final_score,status,execution_source,available_at,llm_council_runs!inner(id,market,symbol,status,completed_at,consensus_score,deterministic_score:input_snapshot->deterministic_score,prediction_contract:input_snapshot->prediction_contract,config_snapshot,created_at)")
      .eq("execution_source", "subscription").eq("status", "completed")
      .order("available_at", { ascending: true }).order("id", { ascending: true }).range(from, to), "delayed subscription forecasts");
  const delayedRuns = new Map<string, any>();
  for (const row of delayed) {
    const run = Array.isArray(row.llm_council_runs) ? row.llm_council_runs[0] : row.llm_council_runs;
    if (run) { run.input_snapshot = { prediction_contract: run.prediction_contract }; run.api_model_ids=apiModelIds(run.id); }
    if (!run || !["completed", "partial"].includes(run.status) || !["subscription", "hybrid"].includes(run.config_snapshot?.execution_mode)) continue;
    delayedRuns.set(run.id, run);
  }
  const availabilityCells: Array<{ market: string; horizon: number; series: number }> = [];
  for (const market of ["us", "india"] as const) {
    phase = `${market} availability closes`;
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
        const marks = await fetchAllRows<any>((from, to) => svc.from("price_cache").select("symbol,date,close")
          .in("symbol", symbolChunk).gte("date", fromDate).order("date", { ascending: true }).order("symbol", { ascending: true }).range(from, to), `${market} availability-aligned closes`);
        for (const mark of marks) {
          const key = String(mark.symbol).toUpperCase();
          const list = markMap.get(key) ?? [];
          list.push({ date: String(mark.date).slice(0, 10), close: mark.close == null ? null : Number(mark.close) });
          markMap.set(key, list);
        }
    }
    try {
      phase = `${market} stored research benchmark`;
      markMap.set(benchmarkSymbolFor(market, "research"), await loadStoredResearchBenchmark(svc, market, fromDate, new Date().toISOString().slice(0, 10)));
    } catch {
      throw new Error(`Could not load ${market} stored research benchmark`);
    }
    for (const horizon of COUNCIL_HORIZONS) {
      const pointMap = new Map<string, CouncilLabelPoint[]>();
      const add = (key: string, symbol: string, session: string, score: unknown, outcome: number) => {
        if (score == null) return;
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
          const deterministic = run.deterministic_score?.composite;
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
        pendingCells.push(...cells.map((cell) => ({
          evaluation_batch_id: batchId, market: cell.market, horizon_days: cell.horizonDays,
          series_key: cell.seriesKey, forecast_model: cell.forecastModel,
          cohort_key: "forecast_available_close_v2", observation_count: cell.observationCount,
          qualifying_sessions: cell.qualifyingSessions, independent_windows: Number(cell.independentWindows.toFixed(4)),
          mean_session_rank_ic: cell.meanSessionRankIc, sd_session_rank_ic: cell.sdSessionRankIc,
          t_stat: cell.tStat, classification: cell.classification,
          reason: `${AVAILABILITY_LABEL_VERSION}. ${cell.reason} Subscription labels use price_cache closes strictly after forecast availability and the versioned research benchmark; gross close-to-close price movement, not execution P&L.`,
        })));
      }
      availabilityCells.push({ market, horizon, series: cells.length });
    }
  }
  phase = "atomic IC publication";
  publicationAttempted = true;
  const { error: writeError } = await svc.from("llm_council_ic_runs").insert(pendingCells);
  if (writeError) throw new Error("Could not publish complete council IC batch");
  publishedBatch = batchId;
  phase = "completion receipt";
  const { error: receiptError } = await svc.from("agent_runs").update({
    status: "done", completed_at: new Date().toISOString(),
    result_summary: `Council IC batch ${batchId}: ${pendingCells.length} cells, both markets, h2/h5/h10/h20; shadow only; no inference.`,
  }).eq("id", receipt.data.id);
  if (receiptError) throw new Error("Council batch published but completion receipt failed");
  return NextResponse.json({ batchId, results: inserted, availabilityAligned: availabilityCells, horizons: COUNCIL_HORIZONS, cohorts: [COUNCIL_COHORT_KEY, COUNCIL_ALL_RESEARCH_COHORT_KEY], delayedCohort: "forecast_available_close_v2", shadowOnly: true });
  } catch {
    // Do not expose database messages (which may contain request details).
    const message = publishedBatch ? `Council IC batch ${publishedBatch} published, but completion receipt failed`
      : publicationAttempted ? `Council IC batch ${batchId} publication unconfirmed; verify ledger before retry`
      : `Council IC evaluation failed at ${phase}; no complete batch published`;
    await svc.from("agent_runs").update({ status: "error", completed_at: new Date().toISOString(), result_summary: message }).eq("id", receipt.data.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Vercel Cron invokes configured routes with GET. Keep the same secret check
// and evaluation body for manual/internal POST calls and scheduled GET calls.
export const GET = POST;
