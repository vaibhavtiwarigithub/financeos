// GET /api/research/council?symbol=NVDA&market=us&limit=12
//
// Stored LLM-council (shadow) forecasts for one symbol, safe for viewers: it reads llm_council_runs and
// llm_council_model_forecasts only, so a viewer opening a symbol never triggers a model or provider call.
// Each run is one research observation (one research slot) scored independently by DeepSeek, Claude and Codex;
// the council is shadow-only and no trade, score or exit reads it.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { councilMemberOf } from "@/lib/research/score-history";

export const dynamic = "force-dynamic";

const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;

  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const requested = req.nextUrl.searchParams.get("market")?.toLowerCase();
  const market = requested ?? (/\.(NS|BO)$/i.test(symbol) ? "india" : "us");
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const limit = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "12", 10) || 12, 1), 40);

  const svc = createServiceClient();
  const { data: runs, error } = await svc
    .from("llm_council_runs")
    .select("id,decision_ts,status,consensus_score,completed_at,failure_code,det:input_snapshot->deterministic_score->>composite,threshold:input_snapshot->deterministic_score->>threshold,direction:input_snapshot->deterministic_score->>direction,cohort:config_snapshot->>cohort_key")
    .eq("symbol", symbol).eq("market", market)
    .order("decision_ts", { ascending: false }).limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const runRows = (runs ?? []) as any[];

  const forecasts: any[] = [];
  if (runRows.length) {
    const { data: rows, error: fError } = await svc
      .from("llm_council_model_forecasts")
      .select("run_id,model_requested,model_used,initial_score,final_score,confidence,final_rationale,bull_case,bear_case,execution_source,available_at")
      .in("run_id", runRows.map((r) => r.id)).eq("status", "completed");
    if (fError) return NextResponse.json({ error: fError.message }, { status: 500 });
    forecasts.push(...(rows ?? []));
  }
  const byRun = new Map<string, any[]>();
  for (const f of forecasts) { const l = byRun.get(f.run_id) ?? []; l.push(f); byRun.set(f.run_id, l); }

  return NextResponse.json({
    symbol, market, shadowOnly: true,
    runs: runRows.map((r) => ({
      id: r.id,
      decisionTs: r.decision_ts,
      status: r.status,
      consensus: num(r.consensus_score),
      deterministic: num(r.det),
      threshold: num(r.threshold),
      direction: r.direction ?? null,
      cohort: r.cohort ?? null,
      completedAt: r.completed_at,
      members: (byRun.get(r.id) ?? []).map((f) => ({
        member: councilMemberOf(f.model_requested),
        model: f.model_used ?? f.model_requested,
        source: f.execution_source,
        score: num(f.final_score),
        confidence: num(f.confidence),
        rationale: typeof f.final_rationale === "string" ? f.final_rationale.slice(0, 600) : null,
        bull: typeof f.bull_case === "string" ? f.bull_case.slice(0, 300) : null,
        bear: typeof f.bear_case === "string" ? f.bear_case.slice(0, 300) : null,
        availableAt: f.available_at,
      })),
    })),
  });
}
