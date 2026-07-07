import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { disconnectKite } from "@/lib/kite";

export const dynamic = "force-dynamic";

// In-app Kite kill switch: invalidates the session with Zerodha and wipes the
// stored access token, so nothing in this app (paper-trade, position-monitor,
// live orders) can make another authenticated Kite call until you log in
// again via /api/kite/login. The most reliable kill switch is still revoking
// from Zerodha's own console (kite.zerodha.com or the Kite Connect apps page)
// -- that works even if this app or its database were compromised -- this is
// the in-app-triggered complement to that, not a replacement.
export async function POST() {
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;

  const result = await disconnectKite(createServiceClient());
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
