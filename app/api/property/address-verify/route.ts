import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { PROPERTY_MARKETS } from "@/lib/property/registry";
import { verifyPropertyAddress } from "@/lib/property/address-verify";

// Pre-save address check. The same verification also runs on save inside
// /api/property/assets, so this route is a convenience, not the gate: it lets
// the owner see whether an address is real BEFORE committing an immutable
// history snapshot. It never writes anything.
export const dynamic = "force-dynamic";

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  if (Number(req.headers.get("content-length") ?? 0) > 4_000) {
    return NextResponse.json({ error: "Address payload is too large" }, { status: 413 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, any> | null;
  if (!body || !PROPERTY_MARKETS.some((entry) => entry.id === body.market)) {
    return NextResponse.json({ error: "A known property market is required to check an address" }, { status: 400 });
  }
  const verification = await verifyPropertyAddress(
    {
      addressLine: text(body.addressLine, 160),
      city: text(body.city, 80),
      region: text(body.region, 80),
      postalCode: text(body.postalCode, 12),
    } as any,
    body.market,
  );
  // The address itself is never echoed back or logged; only the verification.
  return NextResponse.json({ verification });
}
