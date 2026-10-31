// GET /api/research/council/latest?market=us&symbols=NVDA,AMD,...
//
// Newest stored council (shadow) scores for a list of symbols, for tables that already show the deterministic score
// (pending signals, paper trades). Stored rows only, viewer-safe: no model or provider call.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { councilMemberOf } from "@/lib/research/score-history";

export const dynamic = "force-dynamic";

const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const symbols = [...new Set((req.nextUrl.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 120);
  if (!symbols.length) return NextResponse.json({ market, bySymbol: {} });

  const svc = createServiceClient();
  const since = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const { data: runs, error } = await svc.from("llm_council_runs").select("id,symbol,decision_ts,status,consensus_score")
    .eq("market", market).in("symbol", symbols).gte("decision_ts", since).order("decision_ts", { ascending: false }).limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const newest = new Map<string, any>();
  for (const r of (runs ?? []) as any[]) if (!newest.has(r.symbol)) newest.set(r.symbol, r);

  const forecasts: any[] = [];
  const ids = [...newest.values()].map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: fError } = await svc.from("llm_council_model_forecasts").select("run_id,model_requested,final_score")
      .in("run_id", ids.slice(i, i + 200)).eq("status", "completed");
    if (fError) return NextResponse.json({ error: fError.message }, { status: 500 });
    forecasts.push(...(data ?? []));
  }
  // Hybrid batches can contain completed member results while another selected
  // worker is still queued. Read the accepted subscription result directly so its
  // score is visible before the batch closes; keep the composite all-member-only.
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: batchError } = await svc.from("llm_council_batches")
      .select("run_id,llm_council_jobs(expected_model,status,round,result)")
      .in("run_id", ids.slice(i, i + 200));
    if (batchError) return NextResponse.json({ error: batchError.message }, { status: 500 });
    for (const batch of data ?? []) {
      const existing = new Set(forecasts.filter((f: any) => f.run_id === batch.run_id).map((f: any) => f.model_requested));
      const latest = new Map<string, any>();
      for (const job of batch.llm_council_jobs ?? []) {
        const prior = latest.get(job.expected_model);
        if (!prior || Number(job.round ?? 0) > Number(prior.round ?? 0)) latest.set(job.expected_model, job);
      }
      for (const [model_requested, job] of latest) {
        const score = job.result && typeof job.result === "object" ? num((job.result as Record<string, unknown>).score) : null;
        if (!existing.has(model_requested) && job.status === "completed" && score != null && score >= 0 && score <= 100) {
          forecasts.push({ run_id: batch.run_id, model_requested, final_score: score });
        }
      }
    }
  }
  const byRun = new Map<string, any[]>();
  for (const f of forecasts) { const l = byRun.get(f.run_id) ?? []; l.push(f); byRun.set(f.run_id, l); }

  const bySymbol: Record<string, unknown> = {};
  for (const [symbol, run] of newest) {
    const members: Record<string, number | null> = { deepseek: null, claude: null, codex: null };
    for (const f of byRun.get(run.id) ?? []) { const m = councilMemberOf(f.model_requested); if (m) members[m] = num(f.final_score); }
    const all = Object.values(members).filter((v): v is number => v != null).sort((a, b) => a - b);
    // Stored consensus, else the median of ALL THREE members (a backfilled run); never a median of fewer.
    const median = num(run.consensus_score) ?? (all.length === 3 ? all[1] : null);
    bySymbol[symbol] = { decisionTs: run.decision_ts, status: run.status, median, ...members };
  }
  return NextResponse.json({ market, shadowOnly: true, bySymbol });
}
