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
import { buildCouncilMemberState } from "@/lib/research/council-member-state";

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
    .select("id,decision_ts,status,consensus_score,completed_at,failure_code,config_snapshot,prompt_version,det:input_snapshot->deterministic_score->>composite,threshold:input_snapshot->deterministic_score->>threshold,direction:input_snapshot->deterministic_score->>direction,cohort:config_snapshot->>cohort_key")
    .eq("symbol", symbol).eq("market", market)
    .order("decision_ts", { ascending: false }).limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const runRows = (runs ?? []) as any[];

  const forecasts: any[] = [];
  if (runRows.length) {
    const { data: rows, error: fError } = await svc
      .from("llm_council_model_forecasts")
      .select("run_id,model_requested,model_used,initial_score,final_score,confidence,final_rationale,bull_case,bear_case,evidence_citations,execution_source,available_at")
      .in("run_id", runRows.map((r) => r.id)).eq("status", "completed");
    if (fError) return NextResponse.json({ error: fError.message }, { status: 500 });
    forecasts.push(...(rows ?? []));
  }
  const byRun = new Map<string, any[]>();
  for (const f of forecasts) { const l = byRun.get(f.run_id) ?? []; l.push(f); byRun.set(f.run_id, l); }
  const workerIds = [...new Set(runRows.flatMap((r) => Array.isArray(r.config_snapshot?.subscription_worker_ids) ? r.config_snapshot.subscription_worker_ids : []))];
  const [workerResult, batchResult] = await Promise.all([
    workerIds.length ? svc.from("llm_council_workers").select("id,family,expected_model").in("id", workerIds) : Promise.resolve({ data: [], error: null }),
    runRows.length ? svc.from("llm_council_batches").select("run_id,llm_council_jobs(worker_id,expected_model,actual_model,round,status,failure_code,result,submitted_at)").in("run_id", runRows.map((r) => r.id)) : Promise.resolve({ data: [], error: null }),
  ]);
  if (workerResult.error || batchResult.error) return NextResponse.json({ error: "Council member status unavailable" }, { status: 503 });
  const jobsByRun = new Map<string, any[]>();
  for (const batch of batchResult.data ?? []) jobsByRun.set(batch.run_id, [...(jobsByRun.get(batch.run_id) ?? []), ...(batch.llm_council_jobs ?? [])]);

  // Worker results are immutable and accepted before a hybrid batch becomes terminal.
  // Surface those completed scores immediately; never derive a composite from a subset.
  const workersById = new Map((workerResult.data ?? []).map((w: any) => [w.id, w]));
  const membersByRun = new Map<string, any[]>();
  for (const run of runRows) {
    const rows = (byRun.get(run.id) ?? []).map((f) => ({
      member: councilMemberOf(f.model_requested), model: f.model_used ?? f.model_requested,
      source: f.execution_source, score: num(f.final_score), confidence: num(f.confidence),
      rationale: typeof f.final_rationale === "string" ? f.final_rationale.slice(0, 600) : null,
      bull: typeof f.bull_case === "string" ? f.bull_case.slice(0, 300) : null,
      bear: typeof f.bear_case === "string" ? f.bear_case.slice(0, 300) : null,
      citations: Array.isArray(f.evidence_citations) ? f.evidence_citations.slice(0, 3).map((citation: any) => ({
        claim: typeof citation?.claim === "string" ? citation.claim.slice(0, 160) : "",
        source: typeof citation?.source === "string" ? citation.source.slice(0, 160) : "",
        asOf: typeof citation?.as_of === "string" ? citation.as_of.slice(0, 40) : "unknown",
      })) : [],
      availableAt: f.available_at,
    }));
    const persisted = new Set(rows.filter((f) => f.source === "subscription").map((f) => f.model));
    const latestByWorker = new Map<string, any>();
    for (const job of jobsByRun.get(run.id) ?? []) {
      const prior = latestByWorker.get(job.worker_id);
      if (!prior || Number(job.round ?? 0) > Number(prior.round ?? 0)) latestByWorker.set(job.worker_id, job);
    }
    for (const job of latestByWorker.values()) {
      const worker = workersById.get(job.worker_id) as any;
      const model = job.expected_model ?? worker?.expected_model;
      if (!model || persisted.has(model) || job.status !== "completed" || !job.result || typeof job.result !== "object") continue;
      const result = job.result as Record<string, unknown>;
      const score = num(result.score);
      if (score == null || score < 0 || score > 100) continue;
      rows.push({
        member: councilMemberOf(model), model: job.actual_model ?? model, source: "subscription", score,
        confidence: num(result.confidence),
        rationale: typeof result.rationale === "string" ? result.rationale.slice(0, 600) : null,
        bull: typeof result.bull_case === "string" ? result.bull_case.slice(0, 300) : null,
        bear: typeof result.bear_case === "string" ? result.bear_case.slice(0, 300) : null,
        citations: Array.isArray(result.evidence_citations) ? result.evidence_citations.slice(0, 3).map((citation: any) => ({
          claim: typeof citation?.claim === "string" ? citation.claim.slice(0, 160) : "",
          source: typeof citation?.source === "string" ? citation.source.slice(0, 160) : "",
          asOf: typeof citation?.as_of === "string" ? citation.as_of.slice(0, 40) : "unknown",
        })) : [],
        availableAt: job.submitted_at ?? null,
      });
    }
    membersByRun.set(run.id, rows);
  }

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
      promptVersion: r.prompt_version ?? null,
      completedAt: r.completed_at,
      members: membersByRun.get(r.id) ?? [],
      memberStates: buildCouncilMemberState(r.config_snapshot, byRun.get(r.id) ?? [], workerResult.data ?? [], jobsByRun.get(r.id) ?? []),
    })),
  });
}
