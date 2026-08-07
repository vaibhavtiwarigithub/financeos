import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { PROPERTY_MARKETS } from "@/lib/property/registry";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = new URL(req.url).searchParams.get("market") ?? "austin";
  if (!PROPERTY_MARKETS.some(m => m.id === market)) return NextResponse.json({ error: "Unknown property market" }, { status: 400 });
  const svc = createServiceClient();
  const [{ data: observations }, { data: runs }, { data: forecasts }, { data: sources }] = await Promise.all([
    svc.from("property_market_observations").select("source_key, metric_key, native_unit, value, as_of, published_at, collected_at, revision_state").eq("geography_slug", market).order("as_of", { ascending: true }).limit(2000),
    svc.from("property_source_runs").select("source_key, outcome, started_at, completed_at, rows_written, request_count, error_code").or(`geography_slug.eq.${market},geography_slug.is.null`).order("started_at", { ascending: false }).limit(30),
    svc.from("property_forecasts").select("id, metric_key, horizon_days, cutoff_at, lower_value, base_value, upper_value, model_version, state, created_at").eq("geography_slug", market).order("created_at", { ascending: false }).limit(30),
    svc.from("property_sources").select("source_key, display_name, official_url, permitted_use, cadence, activation_state").order("display_name"),
  ]);
  return NextResponse.json({ market, observations: observations ?? [], runs: runs ?? [], forecasts: forecasts ?? [], sources: sources ?? [] });
}
