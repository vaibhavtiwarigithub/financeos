import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Agent run history — what each agent did, its result, cost, and handoff.
// GET  /api/agents/history?range=1d|1w|all&agent=<type>
// DELETE /api/agents/history?id=<uuid>

// Static handoff map: what each agent hands off to next in the pipeline.
const HANDOFF: Record<string, string> = {
  research:         "→ PaperTrader (signals scored ≥60 become buy candidates)",
  paper_trader:     "→ PositionMonitor (open positions tracked for exits)",
  position_monitor: "→ LearnerAgent (closed trades become learning outcomes)",
  learner:          "→ Strategy Registry (weight challengers await promotion)",
  mentor_evaluate:  "→ Decision Journal (thesis scored for the user)",
  deep_dive:        "→ advisory only (feeds analyst conviction, not execution)",
};

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const range = req.nextUrl.searchParams.get("range") ?? "1w";
  const agent = req.nextUrl.searchParams.get("agent");
  const market = req.nextUrl.searchParams.get("market"); // us|india — global market switcher

  const svc = createServiceClient();
  let since: string | null = null;
  if (range === "1d") since = new Date(Date.now() - 86400_000).toISOString();
  else if (range === "1w") since = new Date(Date.now() - 7 * 86400_000).toISOString();
  // "all" → no lower bound

  let q = svc.from("agent_runs")
    .select("id, agent_type, status, trigger_source, symbols, result_summary, signals_written, error, started_at, completed_at, tokens_input, tokens_output, claude_calls, market")
    .order("started_at", { ascending: false })
    .limit(200);
  if (since) q = q.gte("started_at", since);
  if (agent) q = q.eq("agent_type", agent);
  // agent_runs.market defaults to 'us' (migration 077 backfill) for every
  // agent that isn't market-scoped (learner, mentor, macro-sentinel, etc.) —
  // so filtering to "india" correctly shows only genuinely India-scoped runs
  // (research/paper-trade/position-monitor triggered with ?market=india)
  // instead of every agent's US-default run appearing under both tabs.
  if (market === "india") q = q.eq("market", "india");
  else if (market === "us") q = q.or("market.eq.us,market.is.null"); // a few pre-077 rows never got backfilled

  const { data: runs, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Join cost from llm_call_log by run_id
  const runIds = (runs ?? []).map((r: any) => r.id).filter(Boolean);
  const costByRun: Record<string, { cost: number; calls: number }> = {};
  if (runIds.length) {
    const { data: costs } = await svc.from("llm_call_log")
      .select("run_id, cost_usd")
      .in("run_id", runIds);
    for (const c of (costs ?? []) as any[]) {
      if (!c.run_id) continue;
      if (!costByRun[c.run_id]) costByRun[c.run_id] = { cost: 0, calls: 0 };
      costByRun[c.run_id].cost += Number(c.cost_usd ?? 0);
      costByRun[c.run_id].calls += 1;
    }
  }

  const enriched = (runs ?? []).map((r: any) => {
    const durationMs = r.started_at && r.completed_at
      ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime() : null;
    return {
      ...r,
      handoff: HANDOFF[r.agent_type] ?? null,
      cost_usd: costByRun[r.id]?.cost ?? null,
      llm_calls: costByRun[r.id]?.calls ?? r.claude_calls ?? 0,
      duration_ms: durationMs,
    };
  });

  // Group by agent_type for the UI
  const byAgent: Record<string, any[]> = {};
  for (const r of enriched) {
    (byAgent[r.agent_type] ??= []).push(r);
  }

  return NextResponse.json({ range, runs: enriched, byAgent, total: enriched.length });
}

export async function DELETE(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  const range = req.nextUrl.searchParams.get("clearRange"); // optional bulk clear
  const svc = createServiceClient();

  if (id) {
    const { error } = await svc.from("agent_runs").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ deleted: 1 });
  }

  if (range === "1d" || range === "1w" || range === "all") {
    let del = svc.from("agent_runs").delete();
    if (range !== "all") {
      const since = new Date(Date.now() - (range === "1d" ? 86400_000 : 7 * 86400_000)).toISOString();
      del = del.gte("started_at", since);
    } else {
      del = del.not("id", "is", null); // delete all
    }
    const { error } = await del;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ cleared: range });
  }

  return NextResponse.json({ error: "id or clearRange required" }, { status: 400 });
}
