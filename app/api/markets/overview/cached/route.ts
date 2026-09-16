// GET /api/markets/overview/cached
// Viewer-safe: reads market_overview_snapshots only. No provider call, no LLM.
// The parent /api/markets/overview may call Massive for the owner; this sibling
// returns the snapshot or a degraded response. See viewer architecture note in
// docs/arch/07-coding-conventions.md.
import { NextRequest, NextResponse } from "next/server";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;

  const svc = createServiceClient();
  const { data } = await svc
    .from("market_overview_snapshots")
    .select("session_date, payload, fetched_at")
    .eq("market", "us")
    .order("session_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.payload) {
    return NextResponse.json({
      indices: [], sectors: [],
      sessionDate: null, priorCloseDate: null,
      fetchedAt: new Date().toISOString(),
      stale: true, unavailableCount: 0,
      degraded: "Market data is being prepared — check back after market close",
    });
  }

  return NextResponse.json(data.payload);
}
