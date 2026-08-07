import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { encryptPropertyPayload, propertyEncryptionReady } from "@/lib/property/crypto";
import { evaluateBuyVsRent, evaluatePropertyDownside, evaluateRateShock, evaluateRefinance, evaluateRentalEconomics } from "@/lib/property/scenarios";
import { PROPERTY_MARKETS } from "@/lib/property/registry";

export const dynamic = "force-dynamic";
const ENGINE_VERSION = "property-scenarios-v1";

function calculate(type: string, input: any): { result: unknown; state: string } {
  if (type === "buy" || type === "sell") {
    const result = evaluateBuyVsRent(input);
    return { result, state: Math.abs(result.buyAdvantage) < input.purchasePrice * 0.02 ? "watch" : "actionable" };
  }
  if (type === "rent") {
    const result = evaluateRentalEconomics(input);
    return { result, state: result.annualCashFlow > 0 && (result.dscr == null || result.dscr >= 1.2) ? "actionable" : "not_economic_under_assumptions" };
  }
  if (type === "refinance") {
    const result = evaluateRefinance(input);
    return { result, state: result.isNpvPositive && result.breakevenMonth != null ? "actionable" : "not_economic_under_assumptions" };
  }
  if (type === "heloc" || type === "home_loan" || type === "loan_against_property") {
    const result = evaluateRateShock(input);
    return { result, state: result.monthlyPaymentChange <= 0 ? "actionable" : "watch" };
  }
  if (type === "downside") {
    const result = evaluatePropertyDownside(input);
    return { result, state: result.breaches.length ? "watch" : "actionable" };
  }
  throw new RangeError("Unsupported scenario type");
}

export async function GET() {
  const gate = await requireOwner(); if (gate) return gate;
  const client = await createClient(); const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await createServiceClient().from("property_scenarios").select("id, geography_slug, property_asset_id, scenario_type, result_json, engine_version, decision_state, created_at").eq("owner_id", user.id).order("created_at", { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: "Property scenarios are temporarily unavailable" }, { status: 503 });
  return NextResponse.json({ scenarios: data ?? [], encryptionReady: propertyEncryptionReady() });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  if (!propertyEncryptionReady()) return NextResponse.json({ error: "Scenario storage is locked until PROPERTY_DATA_ENCRYPTION_KEY is configured" }, { status: 503 });
  const client = await createClient(); const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  if (!PROPERTY_MARKETS.some(m => m.id === body.market) || !body.inputs || typeof body.inputs !== "object") return NextResponse.json({ error: "Invalid scenario" }, { status: 400 });
  try {
    const calculated = calculate(String(body.scenarioType), body.inputs);
    const svc = createServiceClient();
    const { data, error } = await svc.from("property_scenarios").insert({ owner_id: user.id, geography_slug: body.market, property_asset_id: body.propertyAssetId ?? null, scenario_type: body.scenarioType, encrypted_inputs: encryptPropertyPayload(body.inputs), result_json: calculated.result, engine_version: ENGINE_VERSION, decision_state: calculated.state }).select("id, result_json, decision_state, created_at").single();
    if (error) return NextResponse.json({ error: "Scenario could not be saved" }, { status: 503 });
    await svc.from("property_decision_journal").insert({ owner_id: user.id, scenario_id: data.id, geography_slug: body.market, recommendation_state: calculated.state, evidence_refs: [{ kind: "scenario", engineVersion: ENGINE_VERSION }] });
    return NextResponse.json({ ok: true, scenario: data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid scenario inputs" }, { status: 400 });
  }
}
