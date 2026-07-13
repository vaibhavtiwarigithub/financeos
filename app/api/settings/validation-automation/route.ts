import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

const MARKETS = new Set(["us", "india"]);

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const { data, error } = await createServiceClient().from("strategy_validation_automation").select("*").order("market");
  if (error) return NextResponse.json({ policies: [], degraded: true, reason: "Migration 170 is required." });
  return NextResponse.json({ policies: data ?? [], degraded: false });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  if (!MARKETS.has(body.market) || typeof body.enabled !== "boolean" || typeof body.auto_shadow_enabled !== "boolean") {
    return NextResponse.json({ error: "market, enabled, and auto_shadow_enabled are required." }, { status: 400 });
  }
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  const { data, error } = await createServiceClient().from("strategy_validation_automation").upsert({
    market: body.market,
    enabled: body.enabled,
    auto_shadow_enabled: body.auto_shadow_enabled,
    max_active_shadows: 1,
    updated_by: user?.id ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "market" }).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ policy: data });
}
