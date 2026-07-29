import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireOwner();
  if (denied) return denied;

  const service = createServiceClient();
  const { data, error } = await service
    .from("backtest_experiments")
    .select(
      "id,market,edge_id,formula_version,horizon_sessions,data_cutoff,code_version," +
      "started_at,completed_at,result_summary,plan_fingerprint,dataset_fingerprint," +
      "universe_fingerprint,run_fingerprint",
    )
    .eq("experiment_type", "historical_replay")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) {
    return NextResponse.json({ error: "Historical experiment ledger unavailable" }, { status: 500 });
  }

  return NextResponse.json({
    runs: (data ?? []).map((row: Record<string, any>) => ({
      ...row,
      // The local path and service credentials are never stored or returned.
      result_summary: row.result_summary ?? null,
    })),
  });
}
