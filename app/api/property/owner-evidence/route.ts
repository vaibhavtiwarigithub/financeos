import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { encryptPropertyPayload, propertyContentHash, propertyEncryptionReady } from "@/lib/property/crypto";
import { parsePropertyEvidenceImport } from "@/lib/property/import-contract";

export async function GET() {
  const gate = await requireOwner(); if (gate) return gate;
  const client = await createClient(); const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await createServiceClient()
    .from("property_imports")
    .select("id, geography_slug, import_type, source_label, as_of, created_at")
    .eq("owner_id", user.id)
    .in("import_type", ["tax_notice", "insurance_quote"])
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "Evidence records could not be read" }, { status: 503 });
  return NextResponse.json({ encryptionReady: propertyEncryptionReady(), records: data ?? [] });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  if (!propertyEncryptionReady()) return NextResponse.json({ error: "Private evidence storage is locked until PROPERTY_DATA_ENCRYPTION_KEY is configured" }, { status: 503 });
  const client = await createClient(); const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 }); }
  const parsed = parsePropertyEvidenceImport(body);
  if (!parsed) return NextResponse.json({ error: "Use a tax notice or insurance quote with a label, valid date, and up to 1 MB of text" }, { status: 400 });
  const { data, error } = await createServiceClient().from("property_imports").insert({ owner_id: user.id, geography_slug: parsed.market, import_type: parsed.importType, source_label: parsed.sourceLabel, content_hash: propertyContentHash(parsed.content), encrypted_content: encryptPropertyPayload({ content: parsed.content }), as_of: parsed.asOf }).select("id").single();
  if (error?.code === "23505") return NextResponse.json({ ok: true, duplicate: true });
  if (error) return NextResponse.json({ error: "Evidence could not be stored" }, { status: 503 });
  return NextResponse.json({ ok: true, id: data.id }, { status: 201 });
}
