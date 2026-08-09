import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { encryptPropertyPayload, propertyEncryptionReady } from "@/lib/property/crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) { const gate = await requireOwner(); if (gate) return gate; }
  if (!propertyEncryptionReady()) return NextResponse.json({ error: "Capital Plan storage is locked" }, { status: 503 });
  const svc = createServiceClient();
  const { data: watches, error } = await svc.from("capital_area_watchlists").select("id, owner_id, geography_slug, locality_kind, locality_reference").eq("active", true).limit(100);
  if (error) return NextResponse.json({ error: "Area watches are temporarily unavailable" }, { status: 503 });
  let written = 0;
  for (const watch of watches ?? []) {
    const { data: observations } = await svc.from("property_market_observations")
      .select("source_key, metric_key, value, native_unit, as_of, collected_at, revision_state")
      .eq("geography_slug", watch.geography_slug).in("metric_key", ["price_index", "mortgage_rate", "unemployment_rate"])
      .order("as_of", { ascending: false }).limit(100);
    const latest = new Map<string, unknown>();
    for (const row of observations ?? []) if (!latest.has(row.metric_key)) latest.set(row.metric_key, row);
    const coverage = watch.locality_kind === "metro" && watch.geography_slug !== "bengaluru" ? "metro_only" : "contract_pending";
    const { error: insertError } = await svc.from("capital_decision_runs").insert({
      owner_id: watch.owner_id,
      run_kind: "area_watch_snapshot",
      decision_state: "watch",
      engine_version: "capital_area_watch_v1",
      encrypted_inputs: encryptPropertyPayload({ watchId: watch.id, localityKind: watch.locality_kind, localityReference: watch.locality_reference }),
      encrypted_result: encryptPropertyPayload({ coverage, observationCount: latest.size, evidence: Array.from(latest.values()), note: coverage === "metro_only" ? "Market-level evidence only; not a ZIP or parcel valuation." : "No approved local evidence contract; no locality conclusion generated." }),
      evidence_refs: Array.from(latest.values()).map((row: any) => ({ source: row.source_key, metric: row.metric_key, asOf: row.as_of })),
    });
    if (!insertError) written += 1;
  }
  return NextResponse.json({ ok: true, watches: watches?.length ?? 0, snapshotsWritten: written });
}
