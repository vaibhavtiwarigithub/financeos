import { NextRequest, NextResponse } from "next/server";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { availabilityAlignedLabel, AVAILABILITY_LABEL_VERSION } from "@/lib/llm-council/availability-label";
import { benchmarkSymbolFor, BENCHMARK_REGISTRY_VERSION } from "@/lib/data/benchmark-registry";
import { councilComparisons, predictionLookbackDays, type CouncilComparisonPoint } from "@/lib/learning/council-comparison";
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
  const lookbackDays = predictionLookbackDays(horizon);
  const since = new Date(Date.parse(cutoff) - lookbackDays * 86_400_000).toISOString();
  try {
    const runs: any[] = await fetchAllRows((from, to) => {
      if (from > 60000) throw new Error("Comparison scope exceeds bounded read");
      return svc.from("llm_council_runs")
      .select("id,observation_id,symbol,decision_ts,status,prompt_version,completed_at,config_snapshot,deterministic:input_snapshot->deterministic_score,lineage:input_snapshot->source_formula_lineage,instrument:input_snapshot->features->instrument")
      .eq("market", market).gte("decision_ts", since).lte("created_at", cutoff)
      .in("status", ["completed", "partial"]).order("id").range(from, to);
    }, "Prediction Lab runs");
    if (runs.length > 60000) throw new Error("Comparison scope exceeds bounded read; refusing partial analysis");
    const cohortRuns = runs.filter((r) => r.config_snapshot?.cohort_key === "all_research_v1");
    const eligible = cohortRuns.filter((r) => r.instrument?.family !== "crypto");
    const forecasts: any[] = [];
    for (let i = 0; i < eligible.length; i += 100) {
      const ids = eligible.slice(i, i + 100).map((r) => r.id);
      forecasts.push(...await fetchAllRows((from, to) => svc.from("llm_council_model_forecasts")
        .select("id,run_id,model_requested,model_used,initial_score,execution_source,available_at,created_at")
        .in("run_id", ids).eq("status", "completed").lte("created_at", cutoff).order("id").range(from, to), "Prediction Lab forecasts"));
    }
    const benchmark = benchmarkSymbolFor(market, "research");
    // Price bars before the earliest actual decision cannot label any selected
    // forecast. Keep a one-day timezone margin, rather than scanning a full
    // 480-day price history for a council that only began collecting last week.
    const decisionTimes = eligible.map((r) => Date.parse(r.decision_ts)).filter(Number.isFinite);
    const firstDecision = decisionTimes.length ? Math.min(...decisionTimes) : Date.parse(cutoff);
    const priceSince = new Date(Math.max(Date.parse(since), firstDecision - 86_400_000)).toISOString().slice(0, 10);
    const symbols = [...new Set(eligible.map((r) => String(r.symbol).toUpperCase()))];
    const marks = new Map<string, Array<{ date: string; close: number | null }>>();
    for (let i = 0; i < symbols.length; i += 40) {
      const chunk = symbols.slice(i, i + 40);
      const rows: any[] = await fetchAllRows((from, to) => svc.from("price_cache").select("symbol,date,close")
        .in("symbol", chunk).gte("date", priceSince).lte("date", cutoff.slice(0, 10))
        .order("symbol").order("date").range(from, to), "Prediction Lab marks");
      for (const r of rows) { const list = marks.get(r.symbol) ?? []; list.push({ date: r.date, close: r.close == null ? null : Number(r.close) }); marks.set(r.symbol, list); }
    }
    const benchmarkMarks = await loadStoredResearchBenchmark(svc, market, priceSince, cutoff.slice(0, 10));
    const byRun = new Map<string, any[]>();
    for (const f of forecasts) { const list = byRun.get(f.run_id) ?? []; list.push(f); byRun.set(f.run_id, list); }
    const points: CouncilComparisonPoint[] = [];
    let missingBaseline = 0, missingAvailability = 0, unlabelled = 0, labelledRuns = 0;
    for (const r of eligible) {
      const baseline = r.deterministic?.composite;
      if ((typeof baseline !== "number" && typeof baseline !== "string") || String(baseline).trim() === "" || !Number.isFinite(Number(baseline)) || Number(baseline) < 0 || Number(baseline) > 100) { missingBaseline++; continue; }
      const members = (byRun.get(r.id) ?? []).filter((f) => (typeof f.initial_score === "number" || typeof f.initial_score === "string") && String(f.initial_score).trim() !== "" && Number.isFinite(Number(f.initial_score)) && Number(f.initial_score) >= 0 && Number(f.initial_score) <= 100);
      if (!members.length) continue;
      // All members and their deterministic comparator share a single start.
      const times = members.map((f) => Date.parse(f.available_at ?? (f.execution_source === "api" ? f.created_at : "")));
      if (!Number.isFinite(Date.parse(r.decision_ts)) || times.some((t) => !Number.isFinite(t) || t < Date.parse(r.decision_ts) || t > Date.parse(cutoff))) { missingAvailability++; continue; }
      const availableAt = new Date(Math.max(...times)).toISOString();
      const label = availabilityAlignedLabel({ market, availableAt, asOf: cutoff, horizonDays: horizon, symbolMarks: marks.get(r.symbol) ?? [], benchmarkMarks });
      if (!label) { unlabelled++; continue; }
      labelledRuns++;
      const baselineFormula = r.lineage?.versions
        ? Object.entries(r.lineage.versions).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("/") : "legacy/unknown";
      const family = typeof r.instrument?.family === "string" && r.instrument.family.trim() ? r.instrument.family : "legacy/unknown";
      const baselineIdentity = ` · family ${family} · baseline ${baselineFormula}`;
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
      market, horizon, asOf: cutoff, since, lookbackDays, priceWindowStart: priceSince, shadowOnly: true, cohort: "all_research_v1",
      benchmark, benchmarkVersion: BENCHMARK_REGISTRY_VERSION, labelVersion: AVAILABILITY_LABEL_VERSION,
      benchmarkSource: market === "india" ? "benchmark_price_observations" : "price_cache",
      convention: "Gross price excess return from common forecast-availability close; not execution P&L. Initial scores only. Effort not available in this projection; no cross-model winner verdict.",
      coverage: { runs: eligible.length, forecasts: forecasts.length, benchmarkMarks: benchmarkMarks.length, labelledRuns, missingBaseline, missingAvailability, unlabelled, unsupportedFamilyRuns: cohortRuns.length - eligible.length },
      cells: councilComparisons(points, market, horizon),
      caveat: "Read-time regular-market descriptive reconstruction from current cached marks, not a sealed prospective experiment. Recorded crypto is excluded because its 24/7 calendar is incompatible with these labels. Frozen instrument families are separated; unknown history is not reclassified. Different method rows can have different samples; each baseline is paired only within its own row. No significance, promotion or future-gain claim.",
    });
  } catch {
    return NextResponse.json({ error: "Prediction Lab comparison unavailable; complete source reads required" }, { status: 503 });
  }
}
