import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { countiesForMarket, PROPERTY_MARKETS } from "@/lib/property/registry";
import { propertyEncryptionReady } from "@/lib/property/crypto";

export const dynamic = "force-dynamic";
const OVERVIEW_METRICS = [
  "price_index", "rent_index", "rent_reference_studio", "rent_reference_one_bedroom",
  "rent_reference_two_bedroom", "rent_reference_three_bedroom", "rent_reference_four_bedroom",
  "mortgage_rate", "unemployment_rate",
] as const;
const OBSERVATIONS_PER_METRIC = 500;
type AssetSummaryRow = { geography_slug: string; asset_type: string };
type SourceSummaryRow = { source_key: string; display_name: string; cadence: string; activation_state: string };

async function currentOwnerId(): Promise<string | null> {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = new URL(req.url).searchParams.get("market") ?? "austin";
  if (!PROPERTY_MARKETS.some(m => m.id === market)) return NextResponse.json({ error: "Unknown property market" }, { status: 400 });
  const ownerId = await currentOwnerId();
  if (!ownerId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  // Bound each metric independently. A single high-frequency series must not
  // consume a shared limit and hide lower-frequency price or rent history.
  const [observationResults, runsResult, forecastsResult, sourcesResult, assetResult, countyResult] = await Promise.all([
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
    // The overview only needs record state and classification. Never fetch the
    // encrypted payload here: values, addresses, loans, and carrying costs stay
    // behind the dedicated owner-record route.
    svc.from("property_assets").select("geography_slug, asset_type").eq("owner_id", ownerId).is("archived_at", null),
    market === "bengaluru" ? Promise.resolve({ data: [], error: null }) : svc.from("property_county_observations").select("county_fips, metric_key, value, native_unit, as_of, source_version, collected_at").eq("market_slug", market).order("as_of", { ascending: false }).order("collected_at", { ascending: false }).limit(100),
  ]);
  if (observationResults.some((result) => result.error) || runsResult.error || forecastsResult.error || sourcesResult.error || assetResult.error || countyResult.error) {
    return NextResponse.json({ error: "Property market overview is temporarily unavailable" }, { status: 503 });
  }
  const observations = observationResults.flatMap((result) => result.data ?? [])
    .sort((a: any, b: any) => {
      const dateOrder = String(a.as_of).localeCompare(String(b.as_of));
      return dateOrder || String(a.collected_at).localeCompare(String(b.collected_at));
    });
  const activeAssets = (assetResult.data ?? []) as AssetSummaryRow[];
  const activeSources = ((sourcesResult.data ?? []) as SourceSummaryRow[]).filter((source) => source.activation_state === "active");
  return NextResponse.json({
    market,
    observations,
    runs: runsResult.data ?? [],
    forecasts: forecastsResult.data ?? [],
    countyScope: countiesForMarket(market as any),
    countyObservations: countyResult.data ?? [],
    sources: sourcesResult.data ?? [],
    workspace: {
      privateRecords: {
        activeCount: activeAssets.length,
        storageStatus: propertyEncryptionReady() ? "ready" : "locked",
        byMarket: PROPERTY_MARKETS.map((propertyMarket) => ({
          market: propertyMarket.id,
          count: activeAssets.filter((asset) => asset.geography_slug === propertyMarket.id).length,
        })),
        byType: ["home", "rental", "land"].map((assetType) => ({
          assetType,
          count: activeAssets.filter((asset) => asset.asset_type === assetType).length,
        })),
      },
      activeSources: activeSources.map((source) => ({
        sourceKey: source.source_key,
        displayName: source.display_name,
        cadence: source.cadence,
      })),
    },
  });
}
