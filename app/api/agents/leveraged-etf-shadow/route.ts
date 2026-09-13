import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { buildLeveragedEtfShadowObservation, type LeveragedEtfShadowInput } from "@/lib/trading/leveraged-etf-shadow";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const { data, error } = await createServiceClient().from("leveraged_etf_shadow_observations")
    .select("market_session,observed_at,symbol,underlying_symbol,policy_version,observation_window,measurement_status,missing,features,quote,decision,created_at")
    .order("observed_at", { ascending: false }).limit(90);
  if (error?.code === "42P01") return NextResponse.json({ error: "leveraged_etf_shadow_not_deployed" }, { status: 503 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ observations: data ?? [], influence: "none" });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  let input: LeveragedEtfShadowInput;
  try { input = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  let observation;
  try { observation = buildLeveragedEtfShadowObservation(input); } catch (error: any) {
    return NextResponse.json({ error: "invalid_leveraged_shadow_observation", detail: error?.message ?? "invalid input" }, { status: 400 });
  }
  if (observation.window !== "inside_1100_et") {
    return NextResponse.json({ error: "outside_leveraged_observation_window", detail: "L1 accepts one 11:00–11:14 ET observation only." }, { status: 409 });
  }
  const { error } = await createServiceClient().from("leveraged_etf_shadow_observations").insert({
    market: "us", market_session: observation.marketSession, observed_at: observation.observedAt,
    symbol: observation.symbol, underlying_symbol: observation.underlyingSymbol, policy_version: observation.policyVersion,
    observation_window: observation.window, measurement_status: observation.measurementStatus, missing: observation.missing,
    features: observation.features, quote: observation.quote, decision: observation.decision,
  });
  if (error?.code === "42P01") return NextResponse.json({ error: "leveraged_etf_shadow_not_deployed" }, { status: 503 });
  if (error?.code === "23505") return NextResponse.json({ status: "already_recorded", influence: "none" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ status: "recorded", observation, influence: "none" }, { status: 201 });
}
