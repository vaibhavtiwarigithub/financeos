import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { parseTemplateShadowRequest } from "@/lib/strategy-replay/template-shadow-contract";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();
  const { data, error } = await svc.from("strategy_template_shadow_configs")
    .select("*").eq("market", market).order("created_at", { ascending: false });
  if (error) {
    // A missing migration is not an empty strategy program. Make deployment
    // state explicit so the owner never mistakes a 500 for “no candidates”.
    if (error.code === "42P01") return NextResponse.json({ market, configs: [], status: "not_deployed" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ market, configs: data ?? [], status: "ready" });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const parsed = parseTemplateShadowRequest(await req.json());
  if (!parsed.ok) return NextResponse.json({ error: "invalid_template_shadow", details: parsed.errors }, { status: 400 });
  const p = parsed.value;
  const svc = createServiceClient();
  const { data, error } = await svc.rpc("create_strategy_template_shadow_config", {
    p_market: p.market, p_template_ids: p.templateIds, p_kind: p.kind,
    p_operator: p.operator, p_weights: p.weights, p_rule_version: p.ruleVersion,
    p_trial_family_id: p.trialFamilyId, p_rule_spec: p.ruleSpec, p_fingerprint: p.fingerprint,
  });
  if (error) {
    if (error.code === "42883" || error.code === "42P01") return NextResponse.json({ error: "strategy_shadow_not_deployed" }, { status: 503 });
    return NextResponse.json({ error: "strategy_shadow_refused", detail: error.message }, { status: 409 });
  }
  return NextResponse.json({ config: data, influence: "none" }, { status: 201 });
}
