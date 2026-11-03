import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { evaluateFeature, validateFeatureInputs } from "@/lib/validation/feature-compiler";
import { computeSpearmanIC, passesPromotionRule, shouldRetire, type ICResult } from "@/lib/validation/feature-check";
import { walkForwardFolds, loadLabeledDataset, type LabeledObservation } from "@/lib/learning/dataset";
import { verifyCronSecret } from "@/lib/auth/cron";
import { featureRegistryTransitionReason, nextFeatureRegistryStatus, type FeatureRegistryStatus } from "@/lib/feature-packs/lifecycle";
import { attachFeatureObservationContexts } from "@/lib/learning/feature-observation-context";
import { createHash } from "node:crypto";
import { reportIssue, resolveIssue } from "@/lib/system-health";

const MEASUREMENT_CONTRACT = "feature-availability-forward-neutral-v2";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The registry is an observational lifecycle: proposed -> quarantined ->
// measure_only -> retired. Passing IC evidence never turns a formula into a
// score input; strategy promotion is separately owner-gated. Never executes
// arbitrary code — evaluateFeature only interprets the whitelisted grammar.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate=await requireOwner();if(gate)return gate;
  }

  const supabase = createServiceClient();
  const markets: ("us" | "india")[] = ["us", "india"];
  const results: Record<string, any> = {};

  const { data: features,error:featureError } = await supabase.from("feature_registry").select("*").in("status", ["proposed", "quarantined", "measure_only"]);
  if(featureError)return NextResponse.json({error:"feature_inventory_unavailable"},{status:503});
  if (!features?.length) return NextResponse.json({ success: true, checked: 0 });

  for (const feature of features as any[]) {
    const spec = feature.spec ?? {};
    const inputCheck = validateFeatureInputs(spec.formula ?? "", spec.inputs ?? []);
    if (!inputCheck.ok) {
      await supabase.from("feature_registry").update({ status: "retired", updated_at: new Date().toISOString() }).eq("id", feature.id);
      await supabase.from("feature_registry_history").insert({ feature_id: feature.id, from_status: feature.status, to_status: "retired", reason: `invalid formula: ${inputCheck.reason}` }).then(() => {}, () => {});
      results[feature.name] = { status: "retired", reason: `invalid formula: ${inputCheck.reason}` };
      continue;
    }

    if(!markets.includes(spec.universe)){results[feature.name]={status:feature.status,reason:"explicit_market_required"};continue;}
    const market: "us" | "india" = spec.universe;
    let rows: Awaited<ReturnType<typeof loadRowsWithFeatures>>;
    try {
      if(!feature.created_at)throw new Error("Feature declaration time unavailable");
      rows = await loadRowsWithFeatures(supabase, market, spec.horizon ?? 10,feature.created_at);
    } catch {
      await reportIssue({issueKey:`feature-check:inputs:${market}`,severity:"warn",category:"data",
        title:`${market.toUpperCase()} formula input cohort unavailable`,detail:"A raw feature batch failed or was incomplete; no imputed neutral score or partial-cohort evaluation was written."},supabase);
      return NextResponse.json({error:"feature_input_cohort_unavailable"},{status:503});
    }
    await resolveIssue(`feature-check:inputs:${market}`,supabase);
    const fingerprint=createHash("sha256").update(JSON.stringify({contract:MEASUREMENT_CONTRACT,formula:spec.formula,inputs:spec.inputs,horizon:spec.horizon,
      rows:rows.map(row=>({id:row.id,values:row.__ctx,y:row.benchmark_neutral_return}))})).digest("hex");
    if(spec.measurement?.fingerprint===fingerprint){results[feature.name]={status:feature.status,reason:"unchanged_evidence",measurementContract:MEASUREMENT_CONTRACT};continue;}
    if (rows.length < 30) {
      results[feature.name] = { status: feature.status, reason: "insufficient_data(<30)" };
      continue;
    }

    const folds = walkForwardFolds(rows as any, { folds: 3, testSessions: 30, horizonSessions: spec.horizon ?? 10 });
    const foldICs: ICResult[] = [];
    for (const fold of folds) {
      const pairs = fold.test
        .map((row: any) => ({ x: evaluateFeature(spec.formula, { values: row.__ctx }), y: row.benchmark_neutral_return }))
        .filter((p: any) => p.x != null && p.y != null) as { x: number; y: number }[];
      const ic = computeSpearmanIC(pairs.map(p => p.x), pairs.map(p => p.y));
      if (ic) foldICs.push(ic);
    }
    if (foldICs.length === 0) {
      results[feature.name] = { status: feature.status, reason: "no evaluable folds" };
      continue;
    }

    const contractHistory = spec.measurement?.contract===MEASUREMENT_CONTRACT ? spec.measurement.icHistory ?? [] : [];
    const icHistory: number[] = [...contractHistory, ...foldICs.map(f => f.ic)].slice(-30);
    const currentStatus = feature.status as FeatureRegistryStatus;
    const newStatus = nextFeatureRegistryStatus(
      currentStatus,
      passesPromotionRule(foldICs),
      shouldRetire(icHistory),
    );

    // Freeze the previous method's history before replacing its current projection.
    const evidenceWrite=await supabase.from("feature_registry_history").insert({
      feature_id:feature.id,from_status:feature.status,to_status:feature.status,
      reason:JSON.stringify({contract:MEASUREMENT_CONTRACT,fingerprint,foldICs,priorContract:spec.measurement?.contract ?? "legacy_unversioned",
        priorIcHistory:spec.measurement?.contract===MEASUREMENT_CONTRACT ? undefined : feature.ic_history ?? [],
        proposedStatus:newStatus,authority:"descriptive_measurement_only"}),
    });
    if(evidenceWrite.error)return NextResponse.json({error:"feature_measurement_persistence_failed"},{status:503});
    const projectionWrite=await supabase.from("feature_registry").update({
      status: newStatus, ic_history: icHistory,
      spec:{...spec,measurement:{contract:MEASUREMENT_CONTRACT,fingerprint,icHistory}},updated_at: new Date().toISOString(),
    }).eq("id", feature.id);
    if(projectionWrite.error)return NextResponse.json({error:"feature_projection_persistence_failed"},{status:503});
    if (newStatus !== feature.status) {
      await supabase.from("feature_registry_history").insert({
        feature_id: feature.id, from_status: feature.status, to_status: newStatus,
        reason: JSON.stringify({contract:MEASUREMENT_CONTRACT,fingerprint,foldICs,priorContract:spec.measurement?.contract ?? "legacy_unversioned",
          priorIcHistory:spec.measurement?.contract===MEASUREMENT_CONTRACT ? undefined : feature.ic_history ?? [],
          transition:featureRegistryTransitionReason(currentStatus,newStatus,foldICs.length),authority:"descriptive_measurement_only"}),
      }).then(() => {}, () => {});
    }
    results[feature.name] = { status: newStatus, folds: foldICs,measurementContract:MEASUREMENT_CONTRACT };
  }

  return NextResponse.json({ success: true, checked: features.length, results });
}

// Loads labeled observations WITH their raw features blob attached as __ctx
// (flattened dimension scores + evidence.<dim>.<field>) so evaluateFeature can
// resolve identifiers. loadLabeledDataset doesn't carry the raw jsonb — fetch
// it separately and merge by observation id.
async function loadRowsWithFeatures(supabase: any, market: "us" | "india", horizonDays: 2 | 5 | 10 | 20,declaredAt:string) {
  const base = await loadLabeledDataset(supabase, market, horizonDays,{fromTimestamp:declaredAt});
  if (base.length === 0) return [];
  return attachFeatureObservationContexts(supabase,market,base);
}
