import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { propertyEncryptionReady } from "@/lib/property/crypto";
import type { PropertyValuationStageOneResponse, ValuationSourceCoverage } from "@/lib/property/valuation-contract";

export const dynamic = "force-dynamic";

const SOURCES = {
  "maricopa-sales": { name: "Maricopa County recorded transfers", url: "https://www.mcassessor.maricopa.gov/page/data_sales/" },
  "tcad-appraisal": { name: "Travis Central Appraisal District", url: "https://traviscad.org/publicinformation/" },
} as const;
type SourceKey = keyof typeof SOURCES;
type SourceRow = { source_key: string; display_name: string; official_url: string; activation_state: string };
type SnapshotRow = { id: string; source_key: string; outcome: string; started_at: string; completed_at: string | null };
type EventRow = { bulk_snapshot_id: string; event_type: string; rows_written: number; created_at: string; detail: string | null };

function coverageFor(sourceKey: SourceKey, sources: SourceRow[], snapshots: SnapshotRow[], events: EventRow[], rowCount: number): ValuationSourceCoverage {
  const fallback = SOURCES[sourceKey];
  const source = sources.find((row) => row.source_key === sourceKey);
  const latestSnapshot = snapshots.find((row) => row.source_key === sourceKey) ?? null;
  const latestEvent = latestSnapshot ? events.find((row) => row.bulk_snapshot_id === latestSnapshot.id) ?? null : null;
  let state: ValuationSourceCoverage["state"] = "not_connected";
  if (source && source.activation_state !== "active") state = "inactive";
  if (source?.activation_state === "active") state = rowCount > 0 ? "available" : "no_rows";
  if (latestEvent?.event_type === "write_failed") state = "error";
  return {
    sourceKey, sourceName: source?.display_name ?? fallback.name,
    officialUrl: source?.official_url ?? fallback.url,
    state, activationState: source?.activation_state ?? null, rowCount,
    latestRun: latestSnapshot ? {
      outcome: latestEvent?.event_type ?? latestSnapshot.outcome,
      startedAt: latestSnapshot.started_at, completedAt: latestSnapshot.completed_at,
      rowsWritten: latestEvent?.rows_written ?? 0,
      errorCode: latestEvent?.event_type === "write_failed" ? (latestEvent.detail ?? "write_failed") : null,
    } : null,
  };
}

export async function GET() {
  const gate = await requireOwner(); if (gate) return gate;
  const svc = createServiceClient(); const keys = Object.keys(SOURCES);
  const [sourcesResult, scopesResult, snapshotsResult, eventsResult, salesCountResult, parcelsResult, trendResult] = await Promise.all([
    svc.from("property_sources").select("source_key, display_name, official_url, activation_state").in("source_key", keys),
    svc.from("property_valuation_scopes").select("id, market_slug, scope_kind, scope_value, active").order("created_at"),
    svc.from("property_bulk_snapshots").select("id, source_key, outcome, started_at, completed_at").in("source_key", keys).order("created_at", { ascending: false }).limit(20),
    svc.from("property_bulk_snapshot_events").select("bulk_snapshot_id, event_type, rows_written, created_at, detail").order("created_at", { ascending: false }).limit(40),
    svc.from("property_sales").select("id", { count: "exact", head: true }),
    svc.from("property_parcel_snapshots").select("parcel_key, valuation_year, county_appraised_value, county_assessed_value, observed_at").eq("market_slug", "austin").order("observed_at", { ascending: false }).limit(100),
    svc.from("property_market_observations").select("source_key, native_unit, value, as_of, revision_state").eq("geography_slug", "austin").eq("source_key", "fhfa-hpi").eq("metric_key", "price_index").order("as_of", { ascending: true }).limit(500),
  ]);
  const queryError = sourcesResult.error ?? scopesResult.error ?? snapshotsResult.error ?? eventsResult.error ?? salesCountResult.error ?? parcelsResult.error ?? trendResult.error;
  if (queryError) return NextResponse.json({ error: "Valuation evidence coverage could not be verified" }, { status: 503 });
  const trendRows = (trendResult.data ?? []).flatMap((row: any) => Number.isFinite(Number(row.value)) ? [{ asOf: row.as_of, value: Number(row.value), nativeUnit: row.native_unit, sourceKey: row.source_key, revisionState: row.revision_state }] : []);
  const parcelRows = (parcelsResult.data ?? []).map((row: any, index: number) => ({
    parcelRef: `Private parcel ${index + 1}`, taxYear: Number(row.valuation_year),
    assessedValue: Number(row.county_assessed_value), appraisedValue: row.county_appraised_value == null ? null : Number(row.county_appraised_value),
    currency: "USD" as const, sourceKey: "tcad-appraisal" as const, asOf: row.observed_at,
  })).filter((row: { taxYear: number; assessedValue: number }) => Number.isFinite(row.taxYear) && Number.isFinite(row.assessedValue));
  const sources = (sourcesResult.data ?? []) as SourceRow[];
  const snapshots = (snapshotsResult.data ?? []) as SnapshotRow[];
  const events = (eventsResult.data ?? []) as EventRow[];
  const payload: PropertyValuationStageOneResponse = {
    contractVersion: 1, generatedAt: new Date().toISOString(),
    claims: { avmAvailable: false, marketPriceAvailable: false, parcelValueRangeAvailable: false },
    encryptionReady: propertyEncryptionReady(),
    scopes: (scopesResult.data ?? []).map((row: any) => ({ id: row.id, market: row.market_slug, kind: row.scope_kind, label: row.scope_kind === "postal_code" ? row.scope_value : "Private parcel configured", active: row.active })),
    phoenix: { capability: "recorded_transfer_evidence_status", sales: coverageFor("maricopa-sales", sources, snapshots, events, salesCountResult.count ?? 0) },
    austin: { capability: "assessed_value_reference_only", assessment: coverageFor("tcad-appraisal", sources, snapshots, events, parcelRows.length), assessedValueRows: parcelRows, metroTrend: { state: trendRows.length ? "available" : "no_rows", rows: trendRows } },
  };
  return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  // Neither county source has a verified machine-use licence. Rejecting at the
  // API boundary is deliberate: a future worker cannot be re-enabled merely by
  // adding a scope in the UI.
  return NextResponse.json({ error: "Valuation scope activation is disabled pending source licence verification" }, { status: 409 });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Scope id is required" }, { status: 400 });
  const svc = createServiceClient(); const { error } = await svc.from("property_valuation_scopes").update({ active: false, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return NextResponse.json({ error: "Could not disable scope" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
