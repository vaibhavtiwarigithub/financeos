import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { decryptPropertyPayload, encryptPropertyPayload, propertyEncryptionReady } from "@/lib/property/crypto";

const TYPES = new Set(["mortgage","refinance_quote","heloc","home_loan","loan_against_property"]);
export async function GET() {
  const gate = await requireOwner(); if (gate) return gate;
  const client = await createClient(); const { data: { user } } = await client.auth.getUser();
  if (!user || !propertyEncryptionReady()) return NextResponse.json({ accounts: [], encryptionReady: false });
  const { data, error } = await createServiceClient().from("property_financing_accounts").select("id, property_asset_id, financing_type, display_label, encrypted_payload, created_at, updated_at").eq("owner_id", user.id).order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Financing records are temporarily unavailable" }, { status: 503 });
  try { return NextResponse.json({ encryptionReady: true, accounts: (data ?? []).map((row: any) => ({ ...row, details: decryptPropertyPayload(row.encrypted_payload), encrypted_payload: undefined })) }); }
  catch { return NextResponse.json({ error: "Financing records could not be decrypted" }, { status: 503 }); }
}
export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  if (!propertyEncryptionReady()) return NextResponse.json({ error: "Private financing storage is locked until PROPERTY_DATA_ENCRYPTION_KEY is configured" }, { status: 503 });
  const client = await createClient(); const { data: { user } } = await client.auth.getUser(); if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json(); const label = String(body.displayLabel ?? "").trim();
  if (!TYPES.has(body.financingType) || !label || label.length > 80 || !body.details || typeof body.details !== "object") return NextResponse.json({ error: "Invalid financing record" }, { status: 400 });
  const { data, error } = await createServiceClient().from("property_financing_accounts").insert({ owner_id: user.id, property_asset_id: body.propertyAssetId ?? null, financing_type: body.financingType, display_label: label, encrypted_payload: encryptPropertyPayload(body.details) }).select("id").single();
  if (error) return NextResponse.json({ error: "Financing record could not be saved" }, { status: 503 });
  return NextResponse.json({ ok: true, id: data.id }, { status: 201 });
}
