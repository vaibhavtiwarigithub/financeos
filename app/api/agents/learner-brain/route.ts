import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();

  const { data: runs, error } = await svc
    .from("learner_runs")
    .select("id, run_date, signals_analyzed, trades_analyzed, hypotheses, weight_mutations, mermaid_per_run, model_used, win_rate_snapshot, tokens_in, tokens_out, created_at")
    .order("run_date", { ascending: false })
    .limit(10);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ runs: runs ?? [] });
}
