// GET /api/learning/llm-events-ic
//
// India LLM event extraction (shadow) evidence for the Learning page, viewer-safe aggregates only: the latest nightly
// evaluation cells (event IC, partial IC vs composite and council, redundancy correlations), daily extraction coverage for the
// last 14 days, and the latest per-symbol score summary. Stored rows only; no model or provider call. India only.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { fetchAllRows } from "@/lib/supabase/paginate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;
  const svc = createServiceClient();

  const { data: latest, error: latestError } = await svc.from("llm_event_ic_runs").select("evaluation_batch_id,evaluated_at").order("evaluated_at", { ascending: false }).limit(1);
  if (latestError) return NextResponse.json({ error: latestError.message }, { status: 500 });
  const batchId = latest?.[0]?.evaluation_batch_id ?? null;

  let cells: any[] = [];
  if (batchId) {
    const { data, error } = await svc.from("llm_event_ic_runs")
      .select("horizon_days,series_key,paired_observations,observation_count,qualifying_sessions,independent_windows,mean_session_rank_ic,sd_session_rank_ic,t_stat,classification,reason")
      .eq("evaluation_batch_id", batchId).order("horizon_days", { ascending: true }).limit(200);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    cells = data ?? [];
  }

  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  let items: any[] = [];
  let scores: any[] = [];
  try {
    items = await fetchAllRows((from, to) => svc.from("llm_event_items").select("id,status,reject_reason,event_type,extracted_at,cost_usd")
      .gte("extracted_at", since).order("id", { ascending: true }).range(from, to), "llm event items");
    const { data: lastScore } = await svc.from("llm_event_scores").select("run_id").order("as_of", { ascending: false }).limit(1);
    const runId = lastScore?.[0]?.run_id;
    if (runId) {
      const { data } = await svc.from("llm_event_scores").select("symbol,score,n_items,as_of").eq("run_id", runId).order("score", { ascending: false }).limit(500);
      scores = data ?? [];
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "coverage unavailable" }, { status: 500 });
  }

  const perDay = new Map<string, { ok: number; rejected: number; costUsd: number }>();
  const eventTypes = new Map<string, number>();
  for (const it of items) {
    const d = String(it.extracted_at).slice(0, 10);
    const s = perDay.get(d) ?? { ok: 0, rejected: 0, costUsd: 0 };
    if (it.status === "ok") { s.ok++; eventTypes.set(it.event_type, (eventTypes.get(it.event_type) ?? 0) + 1); } else s.rejected++;
    s.costUsd += Number(it.cost_usd ?? 0);
    perDay.set(d, s);
  }

  return NextResponse.json({
    market: "india", shadowOnly: true, evaluationBatchId: batchId, evaluatedAt: latest?.[0]?.evaluated_at ?? null, cells,
    coverage: [...perDay.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, v]) => ({ date, ok: v.ok, rejected: v.rejected, costUsd: Number(v.costUsd.toFixed(4)) })),
    eventTypes: [...eventTypes.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
    scoreSummary: scores.length ? {
      asOf: scores[0].as_of, symbols: scores.length,
      highest: scores.slice(0, 5).map((s) => ({ symbol: s.symbol, score: Number(s.score), items: s.n_items })),
      lowest: scores.slice(-5).reverse().map((s) => ({ symbol: s.symbol, score: Number(s.score), items: s.n_items })),
    } : null,
  });
}
