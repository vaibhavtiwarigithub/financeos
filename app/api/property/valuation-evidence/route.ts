import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import type { PropertyValuationStageOneResponse, ValuationSourceCoverage } from "@/lib/property/valuation-contract";

export const dynamic = "force-dynamic";

const SOURCES = {
  "maricopa-parcels": { name: "Maricopa County parcel detail", url: "https://www.mcassessor.maricopa.gov/page/data_sales/" },
  "maricopa-sales": { name: "Maricopa County sales affidavits", url: "https://www.mcassessor.maricopa.gov/page/data_sales/" },
  "tcad-assessment": { name: "Travis Central Appraisal District", url: "https://traviscad.org/publicinformation" },
} as const;

type SourceKey = keyof typeof SOURCES;
type SourceRow = { source_key: string; display_name: string; official_url: string; activation_state: string };
type RunRow = { source_key: string; outcome: string; started_at: string; completed_at: string | null; rows_written: number | null; error_code: string | null };
type TrendRow = { source_key: string; native_unit: string; value: number | string; as_of: string; revision_state: string };

function coverageFor(sourceKey: SourceKey, sources: SourceRow[], runs: RunRow[]): ValuationSourceCoverage {
  const fallback = SOURCES[sourceKey];
  const source = sources.find((row) => row.source_key === sourceKey);
  const latestRun = runs.find((row) => row.source_key === sourceKey) ?? null;
  let state: ValuationSourceCoverage["state"] = "not_connected";
  if (source && source.activation_state !== "active") state = "inactive";
  if (source?.activation_state === "active") state = "no_rows";
  if (latestRun?.outcome === "failed") state = "error";
  if (latestRun && ["success", "partial"].includes(latestRun.outcome) && (latestRun.rows_written ?? 0) > 0) state = "available";

  return {
    sourceKey,
    sourceName: source?.display_name ?? fallback.name,
    officialUrl: source?.official_url ?? fallback.url,
    state,
    activationState: source?.activation_state ?? null,
    // No stable parcel/sale/assessment schema is part of this UI stage. A
    // worker's rowsWritten is not a current coverage count.
    rowCount: null,
    latestRun: latestRun ? {
      outcome: latestRun.outcome,
      startedAt: latestRun.started_at,
      completedAt: latestRun.completed_at,
      rowsWritten: latestRun.rows_written,
      errorCode: latestRun.error_code,
    } : null,
  };
}

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const keys = Object.keys(SOURCES);
  const [sourcesResult, runsResult, trendResult] = await Promise.all([
    svc.from("property_sources").select("source_key, display_name, official_url, activation_state").in("source_key", keys),
    svc.from("property_source_runs").select("source_key, outcome, started_at, completed_at, rows_written, error_code").in("source_key", keys).order("started_at", { ascending: false }),
    svc.from("property_market_observations").select("source_key, native_unit, value, as_of, revision_state").eq("geography_slug", "austin").eq("source_key", "fhfa-hpi").eq("metric_key", "price_index").order("as_of", { ascending: true }).limit(500),
  ]);
  const queryError = sourcesResult.error ?? runsResult.error ?? trendResult.error;
  if (queryError) return NextResponse.json({ error: "Valuation evidence coverage could not be verified" }, { status: 503 });

  const sources = (sourcesResult.data ?? []) as SourceRow[];
  const runs = (runsResult.data ?? []) as RunRow[];
  const trendRows = ((trendResult.data ?? []) as TrendRow[]).flatMap((row) => {
    const value = Number(row.value);
    return Number.isFinite(value) ? [{ asOf: row.as_of, value, nativeUnit: row.native_unit, sourceKey: row.source_key, revisionState: row.revision_state }] : [];
  });
  const payload: PropertyValuationStageOneResponse = {
    contractVersion: 1,
    generatedAt: new Date().toISOString(),
    claims: { avmAvailable: false, marketPriceAvailable: false, parcelValueRangeAvailable: false },
    phoenix: {
      capability: "parcel_and_sale_evidence_status",
      parcels: coverageFor("maricopa-parcels", sources, runs),
      sales: coverageFor("maricopa-sales", sources, runs),
    },
    austin: {
      capability: "assessed_value_reference_only",
      assessment: coverageFor("tcad-assessment", sources, runs),
      assessedValueRows: [],
      metroTrend: { state: trendRows.length ? "available" : "no_rows", rows: trendRows },
    },
  };
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
