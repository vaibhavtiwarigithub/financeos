import { NextRequest, NextResponse } from "next/server";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";
import { MINING_HORIZONS, parseMiningRationale } from "@/lib/score-variants/mining";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market");
  const horizon = Number(req.nextUrl.searchParams.get("horizon") ?? "5");
  if ((market !== "us" && market !== "india") || !(MINING_HORIZONS as readonly number[]).includes(horizon)) {
    return NextResponse.json({ error: "market must be us or india and horizon must be 2, 5, 10, or 20" }, { status: 400 });
  }
  const svc = createServiceClient();
  const { data: registry, error: registryError } = await svc.from("score_variant_registry")
    .select("variant_set,variant_id,label,weights,declared_at,rationale")
    .like("variant_set", "formula_mined_v1_%").order("declared_at", { ascending: false }).limit(100);
  if (registryError) return NextResponse.json({ error: "Formula mining registry unavailable" }, { status: 500 });
  const scoped = (registry ?? []).filter((r: any) => {
    const meta = parseMiningRationale(r.rationale);
    return meta?.market === market && Number(meta?.horizonDays) === horizon;
  });
  if (!scoped.length) return NextResponse.json({ market, horizon, variantSet: null, evaluatedAt: null, candidates: [] });
  const variantSet = String(scoped[0].variant_set);
  const candidates = scoped.filter((r: any) => r.variant_set === variantSet).map((r: any) => {
    const meta = parseMiningRationale(r.rationale) ?? {};
    return {
      variantId: r.variant_id, label: r.label, weights: r.weights, declaredAt: r.declared_at,
      fit: meta.historicalFit ?? null, fitCutoff: meta.fitCutoff ?? null, trialCount: meta.trialCount ?? null, totalRunTrials: meta.totalRunTrials ?? null,
      datasetFingerprint: meta.datasetFingerprint ?? null, runFingerprint: meta.runFingerprint ?? null,
      caveat: meta.caveat ?? "Historical formula selection is not forward evidence.",
    };
  });
  const { data: latest, error: latestError } = await svc.from("score_variant_eval_runs")
    .select("evaluation_batch_id,evaluated_at").eq("variant_set", variantSet).eq("market", market).eq("horizon_days", horizon)
    .order("evaluated_at", { ascending: false }).limit(1);
  if (latestError) return NextResponse.json({ error: "Formula evaluation unavailable" }, { status: 500 });
  const batchId = latest?.[0]?.evaluation_batch_id ?? null;
  let cells: any[] = [];
  if (batchId) {
    const { data, error } = await svc.from("score_variant_eval_runs")
      .select("variant_id,sample,sessions,avg_cross_section,independent_windows,variant_mean_ic,variant_ic_t,variant_top_fifth,variant_bottom_fifth,variant_spread,variant_spread_t,baseline_mean_ic,baseline_top_fifth,baseline_bottom_fifth,baseline_spread,classification,meets_adoption_gate,reason")
      .eq("evaluation_batch_id", batchId).eq("variant_set", variantSet).eq("market", market).eq("horizon_days", horizon)
      .limit(100);
    if (error) return NextResponse.json({ error: "Formula evaluation cells unavailable" }, { status: 500 });
    cells = data ?? [];
  }
  return NextResponse.json({ market, horizon, variantSet, evaluatedAt: latest?.[0]?.evaluated_at ?? null, candidates, cells, shadowOnly: true });
}
