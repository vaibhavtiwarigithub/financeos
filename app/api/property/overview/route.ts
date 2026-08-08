import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { PROPERTY_MARKETS } from "@/lib/property/registry";

export const dynamic = "force-dynamic";
const OVERVIEW_METRICS = ["price_index", "rent_index", "mortgage_rate", "unemployment_rate"] as const;
const OBSERVATIONS_PER_METRIC = 500;

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = new URL(req.url).searchParams.get("market") ?? "austin";
  if (!PROPERTY_MARKETS.some(m => m.id === market)) return NextResponse.json({ error: "Unknown property market" }, { status: 400 });
  const svc = createServiceClient();
  // Bound each metric independently. A single high-frequency series must not
  // consume a shared limit and hide lower-frequency price or rent history.
  const [observationResults, runsResult, forecastsResult, sourcesResult] = await Promise.all([
    Promise.all(OVERVIEW_METRICS.map((metric) => svc.from("property_market_observations")
      .select("source_key, metric_key, native_unit, value, as_of, published_at, collected_at, revision_state")
      .eq("geography_slug", market)
      .eq("metric_key", metric)
      .order("as_of", { ascending: false })
      .order("collected_at", { ascending: false })
      .limit(OBSERVATIONS_PER_METRIC))),
    svc.from("property_source_runs").select("source_key, outcome, started_at, completed_at, rows_written, request_count, error_code").or(`geography_slug.eq.${market},geography_slug.is.null`).order("started_at", { ascending: false }).limit(30),
    svc.from("property_forecasts").select("id, source_key, metric_key, horizon_days, cutoff_at, lower_value, base_value, upper_value, model_version, state, created_at").eq("geography_slug", market).order("created_at", { ascending: false }).limit(30),
    svc.from("property_sources").select("source_key, display_name, official_url, permitted_use, cadence, activation_state").order("display_name"),
  ]);
  if (observationResults.some((result) => result.error) || runsResult.error || forecastsResult.error || sourcesResult.error) {
    return NextResponse.json({ error: "Property market overview is temporarily unavailable" }, { status: 503 });
  }
  const observations = observationResults.flatMap((result) => result.data ?? [])
    .sort((a: any, b: any) => {
      const dateOrder = String(a.as_of).localeCompare(String(b.as_of));
      return dateOrder || String(a.collected_at).localeCompare(String(b.collected_at));
    });
  return NextResponse.json({
    market,
    observations,
    runs: runsResult.data ?? [],
    forecasts: forecastsResult.data ?? [],
    sources: sourcesResult.data ?? [],
  });
}
