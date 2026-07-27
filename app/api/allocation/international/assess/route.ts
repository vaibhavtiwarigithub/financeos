import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Observation-only P1 refresh. The RPC writes an immutable current US paper-book
// assessment and has no allocation, candidate, order, or broker side effect.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("refresh_international_allocation_assessment");
  if (error || !data) return NextResponse.json({ error: error?.message ?? "International allocation policy unavailable" }, { status: 503 });
  return NextResponse.json({ ok: true, assessmentId: data, mode: "observe_only" });
}
