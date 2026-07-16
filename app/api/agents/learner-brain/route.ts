import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// GET /api/agents/learner-brain?market=us|india
// Market-scoped: US and India each run their own learner, so their runs must
// never be shown interleaved. `learner_runs.market` is NOT NULL DEFAULT 'us',
// so a plain equality filter is complete — no null-tolerance needed here
// (unlike agent_runs / trade_proposals, whose market column is nullable).
// A missing/unknown ?market= defaults to "us" so pre-existing callers keep working.
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();

  const market: "us" | "india" =
    new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";

  const { data: runs, error } = await svc
    .from("learner_runs")
    .select("id, market, run_date, signals_analyzed, trades_analyzed, hypotheses, weight_mutations, mermaid_per_run, model_used, win_rate_snapshot, tokens_in, tokens_out, created_at")
    .eq("market", market)
    .order("run_date", { ascending: false })
    .limit(10);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ market, runs: runs ?? [] });
}
