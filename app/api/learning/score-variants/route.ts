// GET /api/learning/score-variants?market=us|india
//
// Forward shadow of alternative score formulas for the Learning page, viewer-safe aggregates only: the latest nightly evaluation of the
// pre-registered variants against the live composite, split into FORWARD (judged only on observations after declaration) and HINDSIGHT
// (reference only). Stored rows only; no model or provider call. Nothing here changes any score.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireViewerOrOwner } from "@/lib/auth/session-role";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  // Two registered sets share the evaluation table; each has its own latest batch.
  const set = req.nextUrl.searchParams.get("set") === "insider_v2" ? "insider_v2" : "variant_set_v1";
  const svc = createServiceClient();

  const { data: latest, error: latestError } = await svc.from("score_variant_eval_runs").select("evaluation_batch_id,evaluated_at").eq("variant_set", set).order("evaluated_at", { ascending: false }).limit(1);
  if (latestError) return NextResponse.json({ error: latestError.message }, { status: 500 });
  const batchId = latest?.[0]?.evaluation_batch_id ?? null;
  const { data: registry } = await svc.from("score_variant_registry").select("variant_id,label,weights,declared_at,rationale").eq("variant_set", set).order("variant_id");

  let cells: any[] = [];
  if (batchId) {
    const { data, error } = await svc.from("score_variant_eval_runs")
      .select("variant_id,sample,horizon_days,sessions,avg_cross_section,independent_windows,variant_mean_ic,variant_ic_t,variant_top_fifth,variant_bottom_fifth,variant_spread,variant_spread_t,baseline_mean_ic,baseline_top_fifth,baseline_bottom_fifth,baseline_spread,classification,meets_adoption_gate,reason")
      .eq("evaluation_batch_id", batchId).eq("market", market).limit(200);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    cells = data ?? [];
  }
  return NextResponse.json({ market, set, shadowOnly: true, evaluatedAt: latest?.[0]?.evaluated_at ?? null, declaredAt: registry?.[0]?.declared_at ?? null, registry: registry ?? [], cells });
}
