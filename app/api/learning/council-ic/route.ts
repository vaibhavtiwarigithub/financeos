// GET /api/learning/council-ic?market=us|india
//
// LLM-council (shadow) evidence for the Learning page, viewer-safe aggregates only: the latest nightly evaluation's
// rank-IC cells (per member, composite, deterministic baseline and the fixed 50/50 blend; per horizon and cohort)
// plus coverage (runs by status and member forecasts by day for the last 14 days). Stored rows only.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { councilMemberOf } from "@/lib/research/score-history";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });

  const svc = createServiceClient();
  const { data: latest, error: latestError } = await svc.from("llm_council_ic_runs").select("evaluation_batch_id,evaluated_at").order("evaluated_at", { ascending: false }).limit(1);
  if (latestError) return NextResponse.json({ error: latestError.message }, { status: 500 });
  const batchId = latest?.[0]?.evaluation_batch_id ?? null;

  let cells: any[] = [];
  if (batchId) {
    const { data, error } = await svc.from("llm_council_ic_runs")
      .select("horizon_days,series_key,forecast_model,cohort_key,observation_count,qualifying_sessions,independent_windows,mean_session_rank_ic,sd_session_rank_ic,t_stat,classification,reason")
      .eq("evaluation_batch_id", batchId).eq("market", market).order("horizon_days", { ascending: true }).limit(500);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    cells = data ?? [];
  }

  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  let runRows: any[] = [];
  let forecastRows: any[] = [];
  try {
    runRows = await fetchAllRows((from, to) => svc.from("llm_council_runs").select("id,status,decision_ts")
      .eq("market", market).gte("decision_ts", since).order("decision_ts", { ascending: true }).order("id", { ascending: true }).range(from, to), "council runs");
    forecastRows = await fetchAllRows((from, to) => svc.from("llm_council_model_forecasts").select("run_id,model_requested,status,llm_council_runs!inner(market,decision_ts)")
      .eq("llm_council_runs.market", market).gte("llm_council_runs.decision_ts", since).eq("status", "completed")
      .order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to), "council forecasts");
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "coverage unavailable" }, { status: 500 });
  }

  const day = (iso: string) => String(iso).slice(0, 10);
  const perDay = new Map<string, { runs: number; completed: number; partial: number; failed: number; deepseek: number; claude: number; codex: number }>();
  const slot = (d: string) => perDay.get(d) ?? (perDay.set(d, { runs: 0, completed: 0, partial: 0, failed: 0, deepseek: 0, claude: 0, codex: 0 }), perDay.get(d)!);
  for (const r of runRows) {
    const s = slot(day(r.decision_ts)); s.runs++;
    if (r.status === "completed") s.completed++; else if (r.status === "partial") s.partial++; else if (r.status === "failed") s.failed++;
  }
  for (const f of forecastRows) {
    const run = Array.isArray(f.llm_council_runs) ? f.llm_council_runs[0] : f.llm_council_runs;
    const member = councilMemberOf(f.model_requested);
    if (run?.decision_ts && member) slot(day(run.decision_ts))[member]++;
  }

  return NextResponse.json({
    market, shadowOnly: true, evaluationBatchId: batchId, evaluatedAt: latest?.[0]?.evaluated_at ?? null,
    cells,
    coverage: [...perDay.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, v]) => ({ date, ...v })),
  });
}
