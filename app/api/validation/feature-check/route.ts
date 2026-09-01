import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { evaluateFeature, validateFeatureInputs } from "@/lib/validation/feature-compiler";
import { computeSpearmanIC, passesPromotionRule, shouldRetire, type ICResult } from "@/lib/validation/feature-check";
import { walkForwardFolds, loadLabeledDataset, type LabeledObservation } from "@/lib/learning/dataset";
import { verifyCronSecret } from "@/lib/auth/cron";
import { featureRegistryTransitionReason, nextFeatureRegistryStatus, type FeatureRegistryStatus } from "@/lib/feature-packs/lifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The registry is an observational lifecycle: proposed -> quarantined ->
// measure_only -> retired. Passing IC evidence never turns a formula into a
// score input; strategy promotion is separately owner-gated. Never executes
// arbitrary code — evaluateFeature only interprets the whitelisted grammar.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const markets: ("us" | "india")[] = ["us", "india"];
  const results: Record<string, any> = {};

  const { data: features } = await supabase.from("feature_registry").select("*").in("status", ["proposed", "quarantined", "measure_only"]);
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

    const market: "us" | "india" = markets.includes(spec.universe) ? spec.universe : "us";
    const rows = await loadRowsWithFeatures(supabase, market, spec.horizon ?? 10);
    if (rows.length < 30) {
      results[feature.name] = { status: feature.status, reason: "insufficient_data(<30)" };
      continue;
    }

    const folds = walkForwardFolds(rows as any, { folds: 3, testSessions: 30, horizonSessions: spec.horizon ?? 10 });
    const foldICs: ICResult[] = [];
    for (const fold of folds) {
      const pairs = fold.test
        .map((row: any) => ({ x: evaluateFeature(spec.formula, { values: row.__ctx }), y: row.benchmark_neutral_return ?? row.fwd_return }))
        .filter((p: any) => p.x != null && p.y != null) as { x: number; y: number }[];
      const ic = computeSpearmanIC(pairs.map(p => p.x), pairs.map(p => p.y));
      if (ic) foldICs.push(ic);
    }
    if (foldICs.length === 0) {
      results[feature.name] = { status: feature.status, reason: "no evaluable folds" };
      continue;
    }

    const icHistory: number[] = [...(feature.ic_history ?? []), ...foldICs.map(f => f.ic)].slice(-30);
    const currentStatus = feature.status as FeatureRegistryStatus;
    const newStatus = nextFeatureRegistryStatus(
      currentStatus,
      passesPromotionRule(foldICs),
      shouldRetire(icHistory),
    );

    await supabase.from("feature_registry").update({
      status: newStatus, ic_history: icHistory, updated_at: new Date().toISOString(),
    }).eq("id", feature.id);
    if (newStatus !== feature.status) {
      await supabase.from("feature_registry_history").insert({
        feature_id: feature.id, from_status: feature.status, to_status: newStatus,
        reason: featureRegistryTransitionReason(currentStatus, newStatus, foldICs.length),
      }).then(() => {}, () => {});
    }
    results[feature.name] = { status: newStatus, folds: foldICs };
  }

  return NextResponse.json({ success: true, checked: features.length, results });
}

// Loads labeled observations WITH their raw features blob attached as __ctx
// (flattened dimension scores + evidence.<dim>.<field>) so evaluateFeature can
// resolve identifiers. loadLabeledDataset doesn't carry the raw jsonb — fetch
// it separately and merge by observation id.
async function loadRowsWithFeatures(supabase: any, market: "us" | "india", horizonDays: 2 | 5 | 10 | 20) {
  const base = await loadLabeledDataset(supabase, market, horizonDays);
  if (base.length === 0) return [];
  const ids = base.map((r: LabeledObservation) => r.id);
  const { data: obsRows } = await supabase.from("decision_observations").select("id, features").in("id", ids);
  const featuresById = new Map<number, any>((obsRows ?? []).map((r: any) => [r.id, r.features]));
  return base.map((r: LabeledObservation) => {
    const raw = featuresById.get(r.id) ?? {};
    const ctx: Record<string, number> = {
      fundamental_score: r.fundamental_score ?? 50, technical_score: r.technical_score ?? 50,
      sentiment_score: r.sentiment_score ?? 50, macro_score: r.macro_score ?? 50, insider_score: r.insider_score ?? 50,
    };
    for (const dim of ["fundamental", "technical", "sentiment", "macro", "insider"]) {
      const evidence = raw?.[dim] ?? {};
      for (const [k, v] of Object.entries(evidence)) {
        if (typeof v === "number") ctx[`${dim}.${k}`] = v;
      }
    }
    return { ...r, __ctx: ctx };
  });
}
