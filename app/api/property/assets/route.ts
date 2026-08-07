import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { decryptPropertyPayload, encryptPropertyPayload, propertyEncryptionReady } from "@/lib/property/crypto";
import { PROPERTY_MARKETS } from "@/lib/property/registry";

export const dynamic = "force-dynamic";
const TYPES = new Set(["home", "rental", "land"]);

async function ownerId(): Promise<string | null> {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user?.id ?? null;
}

export async function GET() {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId();
  if (!owner || !propertyEncryptionReady()) return NextResponse.json({ assets: [], encryptionReady: false });
  const svc = createServiceClient();
  const { data, error } = await svc.from("property_assets").select("id, geography_slug, asset_type, display_label, encrypted_payload, created_at, updated_at").eq("owner_id", owner).order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Property assets are temporarily unavailable" }, { status: 503 });
  try {
    return NextResponse.json({ encryptionReady: true, assets: (data ?? []).map((row: any) => ({ ...row, details: decryptPropertyPayload(row.encrypted_payload), encrypted_payload: undefined })) });
  } catch { return NextResponse.json({ error: "Property records could not be decrypted with the configured key" }, { status: 503 }); }
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId();
  if (!owner || !propertyEncryptionReady()) return NextResponse.json({ error: "Private property storage is locked until PROPERTY_DATA_ENCRYPTION_KEY is configured" }, { status: 503 });
  const body = await req.json();
  const label = String(body.displayLabel ?? "").trim();
  if (!PROPERTY_MARKETS.some(m => m.id === body.market) || !TYPES.has(body.assetType) || label.length < 1 || label.length > 80 || !body.details || typeof body.details !== "object") return NextResponse.json({ error: "Invalid property asset" }, { status: 400 });
  const svc = createServiceClient();
  const { data, error } = await svc.from("property_assets").insert({ owner_id: owner, geography_slug: body.market, asset_type: body.assetType, display_label: label, encrypted_payload: encryptPropertyPayload(body.details) }).select("id").single();
  if (error) return NextResponse.json({ error: "Property asset could not be saved" }, { status: 503 });
  return NextResponse.json({ ok: true, id: data.id }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId(); const id = new URL(req.url).searchParams.get("id");
  if (!owner || !id) return NextResponse.json({ error: "Missing asset id" }, { status: 400 });
  const { error } = await createServiceClient().from("property_assets").delete().eq("id", id).eq("owner_id", owner);
  if (error) return NextResponse.json({ error: "Property asset could not be deleted" }, { status: 503 });
  return NextResponse.json({ ok: true });
}
