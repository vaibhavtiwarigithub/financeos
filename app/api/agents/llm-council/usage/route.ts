import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const ALLOWED_DAYS = new Set([7, 30, 90]);

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const requested = req.nextUrl.searchParams.get("days");
  const days = requested == null ? 30 : Number(requested);
  if (!Number.isInteger(days) || !ALLOWED_DAYS.has(days)) {
    return NextResponse.json({ error: "days must be 7, 30, or 90" }, { status: 400 });
  }

  const { data, error } = await createServiceClient().rpc("llm_council_daily_usage", { p_days: days });
  if (error) {
    console.error("[llm-council-usage] daily usage query failed", error.code ?? "unknown");
    return NextResponse.json({ error: "Council usage is temporarily unavailable" }, { status: 503 });
  }

  return NextResponse.json({
    days,
    asOf: new Date().toISOString(),
    rows: data ?? [],
  }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
