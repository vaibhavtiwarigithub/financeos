import { NextRequest, NextResponse } from "next/server";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { availabilityAlignedLabel, AVAILABILITY_LABEL_VERSION } from "@/lib/llm-council/availability-label";
import { benchmarkSymbolFor, BENCHMARK_REGISTRY_VERSION } from "@/lib/data/benchmark-registry";
import { councilComparisons, type CouncilComparisonPoint } from "@/lib/learning/council-comparison";
import { medianScore } from "@/lib/llm-council/core";
import { loadStoredResearchBenchmark } from "@/lib/analytics/benchmark-history";
import { readTechnicalFeatureDiagnostics } from "@/lib/learning/technical-feature-reader";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Read-only, no provider/inference/registration. Reconstruct paired points from
 * canonical stored forecasts; return only aggregates, not private packets.
 * Delayed workers use one shared availability close per run, never pre-result
 * observation labels. Not a causal anchoring test or a winner-selection API.
 */
export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market");
  const horizon = Number(req.nextUrl.searchParams.get("horizon") ?? "10");
  if ((market !== "us" && market !== "india") || ![2, 5, 10, 20].includes(horizon)) return NextResponse.json({ error: "Invalid market or horizon" }, { status: 400 });
  const svc = createServiceClient();
  if (req.nextUrl.searchParams.get("view") === "features") {
    const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase() || null;
    const cohort = req.nextUrl.searchParams.get("cohort") ?? "entry";
    if ((symbol && !/^[A-Z0-9.^-]{1,24}$/.test(symbol)) || !["entry", "holding"].includes(cohort)) return NextResponse.json({ error: "Invalid symbol or cohort" }, { status: 400 });
    try { return NextResponse.json(await readTechnicalFeatureDiagnostics(svc, market, horizon, symbol, cohort as "entry" | "holding")); }
    catch { return NextResponse.json({ error: "Feature comparison unavailable; complete source/session evidence required" }, { status: 503 }); }
  }
  const cutoff = new Date().toISOString();
  const since = new Date(Date.parse(cutoff) - 90 * 86_400_000).toISOString();
  try {
    const runs: any[] = await fetchAllRows((from, to) => svc.from("llm_council_runs")
      .select("id,observation_id,symbol,decision_ts,status,prompt_version,completed_at,config_snapshot,deterministic:input_snapshot->deterministic_score,lineage:input_snapshot->source_formula_lineage")
      .eq("market", market).gte("decision_ts", since).lte("created_at", cutoff)
      .in("status", ["completed", "partial"]).order("id").range(from, to), "Prediction Lab runs");
    if (runs.length > 12000) throw new Error("Comparison scope exceeds bounded read; refusing partial analysis");
    const eligible = runs.filter((r) => r.config_snapshot?.cohort_key === "all_research_v1");
    const forecasts: any[] = [];
    for (let i = 0; i < eligible.length; i += 100) {
      const ids = eligible.slice(i, i + 100).map((r) => r.id);
      forecasts.push(...await fetchAllRows((from, to) => svc.from("llm_council_model_forecasts")
        .select("id,run_id,model_requested,model_used,initial_score,execution_source,available_at,created_at")
        .in("run_id", ids).eq("status", "completed").lte("created_at", cutoff).order("id").range(from, to), "Prediction Lab forecasts"));
    }
    const benchmark = benchmarkSymbolFor(market, "research");
    const symbols = [...new Set(eligible.map((r) => String(r.symbol).toUpperCase()))];
    const marks = new Map<string, Array<{ date: string; close: number | null }>>();
    for (let i = 0; i < symbols.length; i += 40) {
      const chunk = symbols.slice(i, i + 40);
      const rows: any[] = await fetchAllRows((from, to) => svc.from("price_cache").select("symbol,date,close")
        .in("symbol", chunk).gte("date", since.slice(0, 10)).lte("date", cutoff.slice(0, 10))
        .order("symbol").order("date").range(from, to), "Prediction Lab marks");
      for (const r of rows) { const list = marks.get(r.symbol) ?? []; list.push({ date: r.date, close: r.close == null ? null : Number(r.close) }); marks.set(r.symbol, list); }
    }
    const benchmarkMarks = await loadStoredResearchBenchmark(svc, market, since.slice(0, 10), cutoff.slice(0, 10));
    const byRun = new Map<string, any[]>();
    for (const f of forecasts) { const list = byRun.get(f.run_id) ?? []; list.push(f); byRun.set(f.run_id, list); }
    const points: CouncilComparisonPoint[] = [];
    let missingBaseline = 0, missingAvailability = 0, unlabelled = 0, labelledRuns = 0;
    for (const r of eligible) {
      const baseline = r.deterministic?.composite;
      if (baseline == null || !Number.isFinite(Number(baseline)) || Number(baseline) < 0 || Number(baseline) > 100) { missingBaseline++; continue; }
      const members = (byRun.get(r.id) ?? []).filter((f) => f.initial_score != null && Number.isFinite(Number(f.initial_score)) && Number(f.initial_score) >= 0 && Number(f.initial_score) <= 100);
      if (!members.length) continue;
      // All members and their deterministic comparator share a single start.
      const times = members.map((f) => Date.parse(f.available_at ?? (f.execution_source === "api" ? f.created_at : "")));
      if (times.some((t) => !Number.isFinite(t) || t < Date.parse(r.decision_ts) || t > Date.parse(cutoff))) { missingAvailability++; continue; }
      const availableAt = new Date(Math.max(...times)).toISOString();
      const label = availabilityAlignedLabel({ market, availableAt, asOf: cutoff, horizonDays: horizon, symbolMarks: marks.get(r.symbol) ?? [], benchmarkMarks });
      if (!label) { unlabelled++; continue; }
      labelledRuns++;
      const baselineFormula = r.lineage?.versions
        ? Object.entries(r.lineage.versions).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("/") : "legacy/unknown";
      const baselineIdentity = ` · baseline ${baselineFormula}`;
      const roster = members.map((f) => `${f.model_requested}>${f.model_used ?? "unknown"}/${f.execution_source}`).sort().join(" + ");
      const common = { symbol: r.symbol, session: label.entrySession, observationId: String(r.observation_id), decisionTs: r.decision_ts, baseline: Number(baseline), outcome: label.benchmarkNeutralReturn };
      for (const f of members) {
        if (!f.model_used) continue; // do not invent actual model identity
        points.push({ ...common, score: Number(f.initial_score), method: `${f.model_requested} → ${f.model_used} · ${f.execution_source} · ${r.prompt_version} · initial${baselineIdentity}` });
      }
      const median = medianScore(members.map((f) => Number(f.initial_score)));
      if (median != null && members.every((f) => Boolean(f.model_used))) points.push({ ...common, score: median, method: `Initial median [${roster}] · ${r.prompt_version}${baselineIdentity}` });
    }
    return NextResponse.json({
      market, horizon, asOf: cutoff, since, shadowOnly: true, cohort: "all_research_v1",
      benchmark, benchmarkVersion: BENCHMARK_REGISTRY_VERSION, labelVersion: AVAILABILITY_LABEL_VERSION,
      benchmarkSource: market === "india" ? "benchmark_price_observations" : "price_cache",
      convention: "Gross price excess return from common forecast-availability close; not execution P&L. Initial scores only. Effort not available in this projection; no cross-model winner verdict.",
      coverage: { runs: eligible.length, forecasts: forecasts.length, benchmarkMarks: benchmarkMarks.length, labelledRuns, missingBaseline, missingAvailability, unlabelled },
      cells: councilComparisons(points, market, horizon),
      caveat: "Read-time descriptive reconstruction from current cached marks, not a sealed prospective experiment. Different method rows can have different samples; each baseline is paired only within its own row. No significance, promotion or future-gain claim.",
    });
  } catch {
    return NextResponse.json({ error: "Prediction Lab comparison unavailable; complete source reads required" }, { status: 503 });
  }
}
