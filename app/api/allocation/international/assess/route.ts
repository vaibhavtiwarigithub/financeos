import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Observation-only P1 refresh. The RPC writes an immutable current US paper-book
// assessment and has no allocation, candidate, order, or broker side effect.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const requestedMode = new URL(req.url).searchParams.get("mode");
  const mode = requestedMode === "p2_weekly" ? "p2_weekly" : "p1_manual";
  if (mode === "p2_weekly" && !isCron) return NextResponse.json({ error: "P2 weekly shadow is cron-only" }, { status: 403 });
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("refresh_international_allocation_assessment", { p_observation_kind: mode });
  if (error) return NextResponse.json({ error: error.message }, { status: 503 });
  return NextResponse.json({ ok: true, assessmentId: data ?? null, mode });
}
