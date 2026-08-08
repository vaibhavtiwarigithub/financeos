import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { decryptPropertyPayload, encryptPropertyPayload, propertyEncryptionReady } from "@/lib/property/crypto";
import { PROPERTY_MARKETS } from "@/lib/property/registry";
import { geocodeUsPropertyAddress, type PropertyAddress } from "@/lib/property/geocode";

export const dynamic = "force-dynamic";
const TYPES = new Set(["home", "rental", "land"]);

function optionalText(value: unknown, max: number): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new RangeError("Invalid text field");
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new RangeError("Invalid text field");
  return normalized;
}

function optionalNumber(value: unknown, max = 1_000_000_000_000): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) throw new RangeError("Invalid numeric field");
  return number;
}

function sanitizedDetails(value: Record<string, unknown>) {
  return {
    status: value.status === "Watching" ? "Watching" : "Owned",
    value: optionalNumber(value.value),
    loan: optionalNumber(value.loan),
    mortgageRatePct: optionalNumber(value.mortgageRatePct, 100),
    remainingTermMonths: optionalNumber(value.remainingTermMonths, 1_200),
    annualPropertyTax: optionalNumber(value.annualPropertyTax),
    annualInsurance: optionalNumber(value.annualInsurance),
    annualMaintenance: optionalNumber(value.annualMaintenance),
    monthlyHoa: optionalNumber(value.monthlyHoa),
    monthlyOther: optionalNumber(value.monthlyOther),
    address: {
      addressLine: optionalText((value.address as Record<string, unknown> | undefined)?.addressLine, 160),
      city: optionalText((value.address as Record<string, unknown> | undefined)?.city, 80),
      region: optionalText((value.address as Record<string, unknown> | undefined)?.region, 80),
      postalCode: optionalText((value.address as Record<string, unknown> | undefined)?.postalCode, 12),
    },
  };
}

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
  if (Number(req.headers.get("content-length") ?? 0) > 20_000) return NextResponse.json({ error: "Property record is too large" }, { status: 413 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid property asset" }, { status: 400 });
  const label = String(body.displayLabel ?? "").trim();
  if (!PROPERTY_MARKETS.some(m => m.id === body.market) || !TYPES.has(body.assetType) || label.length < 1 || label.length > 80 || !body.details || typeof body.details !== "object") return NextResponse.json({ error: "Invalid property asset" }, { status: 400 });
  let details: ReturnType<typeof sanitizedDetails> & { geocode?: Awaited<ReturnType<typeof geocodeUsPropertyAddress>> };
  if (body.details.status !== "Owned" && body.details.status !== "Watching") return NextResponse.json({ error: "Invalid property status" }, { status: 400 });
  try { details = sanitizedDetails(body.details); }
  catch { return NextResponse.json({ error: "Invalid property details" }, { status: 400 }); }
  if (details.remainingTermMonths != null && (!Number.isInteger(details.remainingTermMonths) || details.remainingTermMonths < 1)) return NextResponse.json({ error: "Remaining term must be a positive whole number of months" }, { status: 400 });
  const address = details.address;
  if (address.postalCode) {
    const validPostalCode = body.market === "bengaluru" ? /^\d{6}$/.test(address.postalCode) : /^\d{5}(?:-\d{4})?$/.test(address.postalCode);
    if (!validPostalCode) return NextResponse.json({ error: body.market === "bengaluru" ? "PIN must be six digits" : "ZIP must be five digits or ZIP+4" }, { status: 400 });
  }
  const hasCompleteAddress = Boolean(address.addressLine && address.city && address.region && address.postalCode);
  if (hasCompleteAddress && body.market !== "bengaluru") {
    details.geocode = await geocodeUsPropertyAddress(address as PropertyAddress);
  }
  const svc = createServiceClient();
  const { data, error } = await svc.from("property_assets").insert({ owner_id: owner, geography_slug: body.market, asset_type: body.assetType, display_label: label, encrypted_payload: encryptPropertyPayload(details) }).select("id").single();
  if (error) return NextResponse.json({ error: "Property asset could not be saved" }, { status: 503 });
  return NextResponse.json({ ok: true, id: data.id, geocode: details.geocode ?? null }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId(); const id = new URL(req.url).searchParams.get("id");
  if (!owner || !id) return NextResponse.json({ error: "Missing asset id" }, { status: 400 });
  const { error } = await createServiceClient().from("property_assets").delete().eq("id", id).eq("owner_id", owner);
  if (error) return NextResponse.json({ error: "Property asset could not be deleted" }, { status: 503 });
  return NextResponse.json({ ok: true });
}
