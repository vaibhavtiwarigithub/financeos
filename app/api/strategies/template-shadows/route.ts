import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { parseTemplateShadowRequest } from "@/lib/strategy-replay/template-shadow-contract";
import { compileStrategyTemplate } from "@/lib/strategy-replay/template-compiler";
import { isMissingStrategyLabSchemaObject } from "@/lib/strategy-replay/schema-errors";
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
    if (isMissingStrategyLabSchemaObject(error)) return NextResponse.json({ market, configs: [], status: "not_deployed" }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ market, configs: data ?? [], status: "ready" });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  let body: Record<string, unknown>;
  try {
    const json = await req.json();
    body = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.kind === "combination") {
    return NextResponse.json({ error: "combination_compiler_not_ready", detail: "The approved P2 combination compiler is not implemented; only a single predeclared template can be compiled." }, { status: 409 });
  }
  const market = body.market === "india" ? "india" : body.market === "us" ? "us" : null;
  const ids = Array.isArray(body.template_ids) ? body.template_ids : [];
  const templateId = ids.length === 1 && typeof ids[0] === "string" ? ids[0] : null;
  const universe = Array.isArray(body.universe) ? body.universe.filter((value): value is string => typeof value === "string") : [];
  const horizonSessions = Number(body.horizon_sessions);
  if (!market || !templateId || ids.length !== 1 || typeof body.horizon_sessions !== "number") {
    return NextResponse.json({ error: "invalid_template_compile_request", details: ["market, one template_id, universe, and integer horizon_sessions are required"] }, { status: 400 });
  }
  const svc = createServiceClient();
  const { data: template, error: templateError } = await svc.from("strategy_templates")
    .select("id,name,description,rules").eq("id", templateId).maybeSingle();
  if (templateError) return NextResponse.json({ error: "strategy_template_read_failed" }, { status: 500 });
  if (!template) return NextResponse.json({ error: "strategy_template_not_found" }, { status: 404 });
  const compiled = compileStrategyTemplate(template, { market, universe, horizonSessions });
  if (!compiled.ok) return NextResponse.json({ error: "template_not_compilable", details: compiled.errors }, { status: 422 });

  const trialFamilyId = `template:${market}:${templateId}:${compiled.compilerVersion}`;
  const parsed = parseTemplateShadowRequest({
    market, template_ids: [templateId], kind: "template", operator: "single", weights: {},
    rule_version: compiled.compilerVersion, trial_family_id: trialFamilyId, rule_spec: compiled.spec,
  });
  if (!parsed.ok) return NextResponse.json({ error: "invalid_template_shadow", details: parsed.errors }, { status: 400 });
  const p = parsed.value;
  const { data, error } = await svc.rpc("create_strategy_template_shadow_config", {
    p_market: p.market, p_template_ids: p.templateIds, p_kind: p.kind,
    p_operator: p.operator, p_weights: p.weights, p_rule_version: p.ruleVersion,
    p_trial_family_id: p.trialFamilyId, p_rule_spec: p.ruleSpec, p_fingerprint: p.fingerprint,
  });
  if (error) {
    if (isMissingStrategyLabSchemaObject(error)) return NextResponse.json({ error: "strategy_shadow_not_deployed" }, { status: 503 });
    return NextResponse.json({ error: "strategy_shadow_refused", detail: error.message }, { status: 409 });
  }
  return NextResponse.json({ config: data, compilerVersion: compiled.compilerVersion, influence: "none" }, { status: 201 });
}
