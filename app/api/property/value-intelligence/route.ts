import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { decryptPropertyPayload, encryptPropertyPayload, propertyEncryptionReady } from "@/lib/property/crypto";
import { buildValueScenarios, indexAdjustedReference, VALUE_KINDS, VALUE_PROVENANCE, type ValueEvidencePayload } from "@/lib/property/value-intelligence";
import { PROPERTY_MARKETS } from "@/lib/property/registry";

export const dynamic = "force-dynamic";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function ownerId() { const client = await createClient(); const { data: { user } } = await client.auth.getUser(); return user?.id ?? null; }
function currency(market: string) { return PROPERTY_MARKETS.find((item) => item.id === market)?.currency ?? null; }

async function assetForOwner(id: string, owner: string) {
  const { data, error } = await createServiceClient().from("property_assets").select("id, geography_slug").eq("id", id).eq("owner_id", owner).is("archived_at", null).maybeSingle();
  if (error) throw new Error("asset_lookup_failed");
  return data;
}

async function referencesForEvidence(owner: string, asset: { id: string; geography_slug: string }, evidenceId: number, payload: ValueEvidencePayload, observedOn: string) {
  const market = asset.geography_slug;
  const marketCurrency = currency(market);
  if (!marketCurrency || market === "bengaluru") return { state: "not_applicable" as const, references: [] };
  const svc = createServiceClient();
  const { data, error } = await svc.from("property_market_observations").select("id, source_key, as_of, value, collected_at, revision_state").eq("geography_slug", market).eq("metric_key", "price_index").order("as_of", { ascending: true }).order("collected_at", { ascending: true }).limit(500);
  if (error) throw new Error("index_lookup_failed");
  const unique = new Map<string, any>();
  for (const row of data ?? []) unique.set(row.as_of, row);
  const points = [...unique.values()].map((row) => ({ asOf: String(row.as_of), value: Number(row.value) })).filter((row) => Number.isFinite(row.value) && row.value > 0);
  const base = [...unique.values()].filter((row) => String(row.as_of) <= observedOn).at(-1);
  const latest = [...unique.values()].at(-1);
  if (!base || !latest || !points.length) return { state: "unavailable" as const, references: [] };
  const adjusted = indexAdjustedReference(payload.amount, Number(base.value), Number(latest.value));
  if (adjusted == null) return { state: "unavailable" as const, references: [] };
  const source = String(latest.source_key);
  const created: unknown[] = [];
  const shared = {
    baseAmount: payload.amount,
    baseObservedOn: observedOn,
    baseIndex: Number(base.value),
    latestIndex: Number(latest.value),
    indexAsOf: String(latest.as_of),
    sourceKey: source,
    sourceObservationIds: { base: Number(base.id), cutoff: Number(latest.id) },
    inputFingerprint: `index_rebase_v1:${evidenceId}:${base.id}:${latest.id}:${observedOn}:${payload.amount}`,
    formula: "base_amount * latest_index / base_index",
    calibration: "unvalidated",
  };
  const { data: reference, error: referenceError } = await svc.from("property_value_references").insert({ owner_id: owner, property_asset_id: asset.id, geography_slug: market, currency: marketCurrency, base_observation_id: evidenceId, result_kind: "indexed_reference", horizon_years: null, model_version: "index_rebase_v1", encrypted_payload: encryptPropertyPayload({ ...shared, lower: null, base: adjusted, upper: null }) }).select("id").single();
  if (referenceError) throw new Error("reference_write_failed");
  created.push({ id: reference.id, kind: "indexed_reference", base: adjusted });
  for (const scenario of buildValueScenarios(adjusted, points)) {
    const { data: row, error: rowError } = await svc.from("property_value_references").insert({ owner_id: owner, property_asset_id: asset.id, geography_slug: market, currency: marketCurrency, base_observation_id: evidenceId, result_kind: "forecast_scenario", horizon_years: scenario.horizonYears, model_version: `index_scenario_v1:${source}`, encrypted_payload: encryptPropertyPayload({ ...shared, ...scenario }) }).select("id").single();
    if (rowError) throw new Error("scenario_write_failed");
    created.push({ id: row.id, kind: "forecast_scenario", horizonYears: scenario.horizonYears });
  }
  return { state: "unvalidated" as const, references: created };
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId(); const assetId = new URL(req.url).searchParams.get("assetId");
  if (!owner || !assetId || !propertyEncryptionReady()) return NextResponse.json({ error: "Property value evidence is unavailable" }, { status: 400 });
  try {
    const asset = await assetForOwner(assetId, owner); if (!asset) return NextResponse.json({ error: "Property not found" }, { status: 404 });
    const svc = createServiceClient();
    const [{ data: evidence, error: evidenceError }, { data: references, error: referencesError }] = await Promise.all([
      svc.from("property_value_observations").select("id, observed_on, kind, provenance, supersedes_id, encrypted_payload, created_at").eq("owner_id", owner).eq("property_asset_id", assetId).order("observed_on", { ascending: false }).order("id", { ascending: false }),
      svc.from("property_value_references").select("id, base_observation_id, result_kind, horizon_years, model_version, encrypted_payload, created_at").eq("owner_id", owner).eq("property_asset_id", assetId).order("created_at", { ascending: false }).limit(20),
    ]);
    if (evidenceError || referencesError) throw new Error("read_failed");
    return NextResponse.json({ market: asset.geography_slug, currency: currency(asset.geography_slug), evidence: (evidence ?? []).map((row: any) => ({ ...row, payload: decryptPropertyPayload<ValueEvidencePayload>(row.encrypted_payload), encrypted_payload: undefined })), references: (references ?? []).map((row: any) => ({ ...row, payload: decryptPropertyPayload<Record<string, unknown>>(row.encrypted_payload), encrypted_payload: undefined })) });
  } catch { return NextResponse.json({ error: "Property value intelligence is temporarily unavailable" }, { status: 503 }); }
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId(); if (!owner || !propertyEncryptionReady()) return NextResponse.json({ error: "Private property storage is locked" }, { status: 503 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const assetId = typeof body?.assetId === "string" ? body.assetId : ""; const kind = typeof body?.kind === "string" ? body.kind : ""; const provenance = typeof body?.provenance === "string" ? body.provenance : ""; const observedOn = typeof body?.observedOn === "string" ? body.observedOn : ""; const amount = Number(body?.amount); const deriveReference = body?.deriveReference === true;
  if (!assetId || !VALUE_KINDS.includes(kind as any) || !VALUE_PROVENANCE.includes(provenance as any) || !ISO_DATE.test(observedOn) || observedOn > new Date().toISOString().slice(0, 10) || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000_000) return NextResponse.json({ error: "Provide a valid evidence type, date, and positive amount" }, { status: 400 });
  try {
    const asset = await assetForOwner(assetId, owner); if (!asset) return NextResponse.json({ error: "Property not found" }, { status: 404 }); const marketCurrency = currency(asset.geography_slug); if (!marketCurrency) throw new Error("market_invalid");
    const payload: ValueEvidencePayload = { amount, sourceLabel: typeof body?.sourceLabel === "string" ? body.sourceLabel.trim().slice(0, 120) || undefined : undefined, rationale: typeof body?.rationale === "string" ? body.rationale.trim().slice(0, 500) || undefined : undefined };
    const { data: inserted, error } = await createServiceClient().from("property_value_observations").insert({ owner_id: owner, property_asset_id: assetId, geography_slug: asset.geography_slug, currency: marketCurrency, observed_on: observedOn, kind, provenance, supersedes_id: typeof body?.supersedesId === "number" ? body.supersedesId : null, encrypted_payload: encryptPropertyPayload(payload) }).select("id").single();
    if (error) throw new Error("write_failed");
    const derived = deriveReference
      ? await referencesForEvidence(owner, asset, inserted.id, payload, observedOn)
      : { state: "not_requested" as const, references: [] };
    return NextResponse.json({ ok: true, evidenceId: inserted.id, derived }, { status: 201 });
  } catch { return NextResponse.json({ error: "Property value evidence could not be recorded" }, { status: 503 }); }
}
