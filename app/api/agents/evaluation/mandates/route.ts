import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const deny = await requireOwner();
  if (deny) return deny;

  const market = new URL(req.url).searchParams.get("market");
  const supabase = createServiceClient();

  let q = supabase
    .from("investment_mandates")
    .select("id, name, market, horizon, benchmark_symbol, min_holding_days, max_holding_days, active")
    .eq("active", true)
    .order("market")
    .order("name");

  if (market) q = q.eq("market", market);

  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, mandates: data ?? [] });
}
