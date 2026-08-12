// GET /api/data-providers/history — last 36 days of provider_budget rows.
// Used by the Settings → Data heatmap. Owner-only (same guard as parent route).
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("provider_budget")
    .select("provider, cache_date, calls")
    .gte("cache_date", new Date(Date.now() - 36 * 86400_000).toISOString().slice(0, 10))
    .order("cache_date", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}
