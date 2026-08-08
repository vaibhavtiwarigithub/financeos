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

function historyAsOf(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value > new Date().toISOString().slice(0, 10)) {
    throw new RangeError("Invalid history date");
  }
  return value;
}

function historySnapshot(market: string, details: ReturnType<typeof sanitizedDetails>) {
  // Address data deliberately stays only in the current encrypted asset payload.
  // Historical points retain valuation and cost inputs, never an address copy.
  return {
    version: 1,
    market,
    value: details.value ?? null,
    loan: details.loan ?? null,
    mortgageRatePct: details.mortgageRatePct ?? null,
    remainingTermMonths: details.remainingTermMonths ?? null,
    annualPropertyTax: details.annualPropertyTax ?? null,
    annualInsurance: details.annualInsurance ?? null,
    annualMaintenance: details.annualMaintenance ?? null,
    monthlyHoa: details.monthlyHoa ?? null,
    monthlyOther: details.monthlyOther ?? null,
  };
}

type AssetMutation = {
  label: string;
  market: string;
  assetType: string;
  details: ReturnType<typeof sanitizedDetails> & { geocode?: Awaited<ReturnType<typeof geocodeUsPropertyAddress>> };
  asOf?: string;
};

async function prepareAssetMutation(body: Record<string, any>): Promise<AssetMutation> {
  const label = String(body.displayLabel ?? "").trim();
  if (!PROPERTY_MARKETS.some(m => m.id === body.market) || !TYPES.has(body.assetType) || label.length < 1 || label.length > 80 || !body.details || typeof body.details !== "object") {
    throw new RangeError("Invalid property asset");
  }
  if (body.details.status !== "Owned" && body.details.status !== "Watching") throw new RangeError("Invalid property status");
  const details: ReturnType<typeof sanitizedDetails> & { geocode?: Awaited<ReturnType<typeof geocodeUsPropertyAddress>> } = sanitizedDetails(body.details);
  if (details.remainingTermMonths != null && (!Number.isInteger(details.remainingTermMonths) || details.remainingTermMonths < 1)) {
    throw new RangeError("Remaining term must be a positive whole number of months");
  }
  const address = details.address;
  if (address.postalCode) {
    const validPostalCode = body.market === "bengaluru" ? /^\d{6}$/.test(address.postalCode) : /^\d{5}(?:-\d{4})?$/.test(address.postalCode);
    if (!validPostalCode) throw new RangeError(body.market === "bengaluru" ? "PIN must be six digits" : "ZIP must be five digits or ZIP+4");
  }
  if (address.addressLine && address.city && address.region && address.postalCode && body.market !== "bengaluru") {
    details.geocode = await geocodeUsPropertyAddress(address as PropertyAddress);
  }
  return { label, market: body.market, assetType: body.assetType, details, asOf: historyAsOf(body.asOf) };
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
  const { data, error } = await svc.from("property_assets").select("id, geography_slug, asset_type, display_label, encrypted_payload, created_at, updated_at").eq("owner_id", owner).is("archived_at", null).order("updated_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Property assets are temporarily unavailable" }, { status: 503 });
  const assetIds = (data ?? []).map((row: any) => row.id);
  const { data: history, error: historyError } = assetIds.length
    ? await svc.from("property_asset_history").select("id, property_asset_id, event_kind, as_of, encrypted_payload, created_at").eq("owner_id", owner).in("property_asset_id", assetIds).order("as_of", { ascending: true }).order("id", { ascending: true })
    : { data: [], error: null };
  if (historyError) return NextResponse.json({ error: "Property history is temporarily unavailable" }, { status: 503 });
  try {
    return NextResponse.json({
      encryptionReady: true,
      assets: (data ?? []).map((row: any) => ({ ...row, details: decryptPropertyPayload(row.encrypted_payload), encrypted_payload: undefined })),
      history: (history ?? []).map((row: any) => ({ ...row, snapshot: decryptPropertyPayload(row.encrypted_payload), encrypted_payload: undefined })),
    });
  } catch { return NextResponse.json({ error: "Property records could not be decrypted with the configured key" }, { status: 503 }); }
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId();
  if (!owner || !propertyEncryptionReady()) return NextResponse.json({ error: "Private property storage is locked until PROPERTY_DATA_ENCRYPTION_KEY is configured" }, { status: 503 });
  if (Number(req.headers.get("content-length") ?? 0) > 20_000) return NextResponse.json({ error: "Property record is too large" }, { status: 413 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid property asset" }, { status: 400 });
  let mutation: AssetMutation;
  try { mutation = await prepareAssetMutation(body); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid property details" }, { status: 400 }); }
  const svc = createServiceClient();
  const { data, error } = await svc.rpc("create_property_asset_with_history", {
    p_owner_id: owner, p_geography_slug: mutation.market, p_asset_type: mutation.assetType, p_display_label: mutation.label,
    p_encrypted_payload: encryptPropertyPayload(mutation.details), p_history_payload: encryptPropertyPayload(historySnapshot(mutation.market, mutation.details)), p_as_of: mutation.asOf ?? null,
  });
  if (error) return NextResponse.json({ error: "Property asset could not be saved" }, { status: 503 });
  return NextResponse.json({ ok: true, id: data, geocode: mutation.details.geocode ?? null }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId();
  if (!owner || !propertyEncryptionReady()) return NextResponse.json({ error: "Private property storage is locked until PROPERTY_DATA_ENCRYPTION_KEY is configured" }, { status: 503 });
  if (Number(req.headers.get("content-length") ?? 0) > 20_000) return NextResponse.json({ error: "Property record is too large" }, { status: 413 });
  const body = await req.json().catch(() => null) as Record<string, any> | null;
  if (!body || typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "Invalid property asset" }, { status: 400 });
  let mutation: AssetMutation;
  try { mutation = await prepareAssetMutation(body); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid property details" }, { status: 400 }); }
  const { data, error } = await createServiceClient().rpc("update_property_asset_with_history", {
    p_owner_id: owner, p_asset_id: body.id, p_geography_slug: mutation.market, p_asset_type: mutation.assetType, p_display_label: mutation.label,
    p_encrypted_payload: encryptPropertyPayload(mutation.details), p_history_payload: encryptPropertyPayload(historySnapshot(mutation.market, mutation.details)), p_as_of: mutation.asOf ?? null,
  });
  if (error) return NextResponse.json({ error: "Property asset could not be updated" }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Property record was not found" }, { status: 404 });
  return NextResponse.json({ ok: true, geocode: mutation.details.geocode ?? null });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const owner = await ownerId(); const id = new URL(req.url).searchParams.get("id");
  if (!owner || !id) return NextResponse.json({ error: "Missing asset id" }, { status: 400 });
  const { data, error } = await createServiceClient().rpc("archive_property_asset", { p_owner_id: owner, p_asset_id: id });
  if (error) return NextResponse.json({ error: "Property asset could not be archived" }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Property record was not found" }, { status: 404 });
  return NextResponse.json({ ok: true, archived: true });
}
