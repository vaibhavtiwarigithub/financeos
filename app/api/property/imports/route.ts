import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { encryptPropertyPayload, propertyContentHash, propertyEncryptionReady } from "@/lib/property/crypto";

const TYPES = new Set(["comps","lender_quote","rent_roll","tax_notice","insurance_quote","registration_evidence"]);

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  if (!propertyEncryptionReady()) return NextResponse.json({ error: "Private import storage is locked until PROPERTY_DATA_ENCRYPTION_KEY is configured" }, { status: 503 });
  const client = await createClient(); const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json(); const content = String(body.content ?? ""); const label = String(body.sourceLabel ?? "").trim();
  if (!TYPES.has(body.importType) || !label || !content || Buffer.byteLength(content, "utf8") > 1_000_000) return NextResponse.json({ error: "Invalid import or content exceeds 1 MB" }, { status: 400 });
  const { data, error } = await createServiceClient().from("property_imports").insert({ owner_id: user.id, geography_slug: body.market ?? null, import_type: body.importType, source_label: label, content_hash: propertyContentHash(content), encrypted_content: encryptPropertyPayload({ content }), as_of: body.asOf ?? null }).select("id").single();
  if (error?.code === "23505") return NextResponse.json({ ok: true, duplicate: true });
  if (error) return NextResponse.json({ error: "Import could not be stored" }, { status: 503 });
  return NextResponse.json({ ok: true, id: data.id }, { status: 201 });
}
