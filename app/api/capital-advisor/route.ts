import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { decryptPropertyPayload, encryptPropertyPayload, propertyEncryptionReady } from "@/lib/property/crypto";
import { compareCrossAsset, compareMortgagePrepayment, type CrossAssetInput, type MortgagePrepaymentInput } from "@/lib/capital-advisor/math";

const ENGINE_VERSION = "capital_advisor_v1";
const MARKETS = new Set(["austin", "phoenix", "bengaluru"]);
const LOCALITY_KINDS = new Set(["metro", "city", "zip", "pin", "locality"]);
const ASSET_FOCUS = new Set(["home", "rental", "land", "mixed"]);

async function ownerId(): Promise<string | null> {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user?.id ?? null;
}
function safeDecrypt(value: string): unknown | null { try { return decryptPropertyPayload(value); } catch { return null; } }

export async function GET() {
  const gate = await requireOwner(); if (gate) return gate;
  if (!propertyEncryptionReady()) return NextResponse.json({ encryptionReady: false, profile: null, watches: [], runs: [] });
  const owner = await ownerId(); if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const [{ data: profile }, { data: watches }, { data: runs }] = await Promise.all([
    svc.from("capital_profiles").select("encrypted_payload, updated_at").eq("owner_id", owner).maybeSingle(),
    svc.from("capital_area_watchlists").select("id, geography_slug, display_label, locality_kind, locality_reference, asset_focus, encrypted_payload, active, created_at, updated_at").eq("owner_id", owner).order("updated_at", { ascending: false }),
    svc.from("capital_decision_runs").select("id, run_kind, decision_state, engine_version, encrypted_inputs, encrypted_result, evidence_refs, created_at").eq("owner_id", owner).order("created_at", { ascending: false }).limit(25),
  ]);
  return NextResponse.json({
    encryptionReady: true,
    profile: profile ? { payload: safeDecrypt(profile.encrypted_payload), updatedAt: profile.updated_at } : null,
    watches: (watches ?? []).map((row: any) => ({ ...row, payload: safeDecrypt(row.encrypted_payload), encrypted_payload: undefined })),
    runs: (runs ?? []).map((row: any) => ({ ...row, inputs: safeDecrypt(row.encrypted_inputs), result: safeDecrypt(row.encrypted_result), encrypted_inputs: undefined, encrypted_result: undefined })),
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  if (!propertyEncryptionReady()) return NextResponse.json({ error: "Capital Plan storage is locked until PROPERTY_DATA_ENCRYPTION_KEY is configured" }, { status: 503 });
  const owner = await ownerId(); if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any; try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const svc = createServiceClient();
  if (body?.action === "save_profile") {
    if (!body.profile || typeof body.profile !== "object") return NextResponse.json({ error: "Invalid capital profile" }, { status: 400 });
    const sealed = encryptPropertyPayload(body.profile);
    const { error } = await svc.from("capital_profiles").upsert({ owner_id: owner, encrypted_payload: sealed, updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
    if (error) return NextResponse.json({ error: "Capital profile could not be saved" }, { status: 503 });
    await svc.from("capital_profile_snapshots").insert({ owner_id: owner, encrypted_payload: sealed });
    return NextResponse.json({ ok: true });
  }
  if (body?.action === "create_watch") {
    const market = String(body.market ?? ""); const label = String(body.label ?? "").trim(); const localityKind = String(body.localityKind ?? ""); const localityReference = String(body.localityReference ?? "").trim(); const assetFocus = String(body.assetFocus ?? "");
    if (!MARKETS.has(market) || !LOCALITY_KINDS.has(localityKind) || !ASSET_FOCUS.has(assetFocus) || !label || label.length > 80 || !localityReference || localityReference.length > 120) return NextResponse.json({ error: "Invalid area watch" }, { status: 400 });
    const { data, error } = await svc.from("capital_area_watchlists").insert({ owner_id: owner, geography_slug: market, display_label: label, locality_kind: localityKind, locality_reference: localityReference, asset_focus: assetFocus, encrypted_payload: encryptPropertyPayload({ budget: body.budget ?? null, goal: String(body.goal ?? "").slice(0, 240), cadence: "weekly_when_supported" }) }).select("id").single();
    if (error) return NextResponse.json({ error: "Area watch could not be saved" }, { status: 503 });
    return NextResponse.json({ ok: true, id: data.id }, { status: 201 });
  }
  if (body?.action === "mortgage_compare" || body?.action === "cross_asset_compare") {
    try {
      const result = body.action === "mortgage_compare" ? compareMortgagePrepayment(body.input as MortgagePrepaymentInput) : compareCrossAsset(body.input as CrossAssetInput);
      const { data, error } = await svc.from("capital_decision_runs").insert({ owner_id: owner, run_kind: body.action === "mortgage_compare" ? "mortgage_prepayment" : "cross_asset_comparison", decision_state: result.state, engine_version: ENGINE_VERSION, encrypted_inputs: encryptPropertyPayload(body.input), encrypted_result: encryptPropertyPayload(result), evidence_refs: [{ kind: "owner_entered_assumptions", engineVersion: ENGINE_VERSION }] }).select("id, created_at").single();
      if (error) return NextResponse.json({ error: "Decision record could not be saved" }, { status: 503 });
      return NextResponse.json({ ok: true, run: { id: data.id, createdAt: data.created_at, result } });
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid comparison input" }, { status: 400 }); }
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
