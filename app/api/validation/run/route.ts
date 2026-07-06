import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { validateChallenger } from "@/lib/validation/engine";

export const dynamic = "force-dynamic";

// Phase 2 learning-core: runs the deterministic Validation Engine for a
// challenger and records a validation_experiments row. This is the ONLY way
// a challenger earns the right to be promoted (see app/api/strategies/versions
// promote_champion's fail-closed gate).
export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { challenger_id, market, horizon_days } = body as { challenger_id?: number; market?: "us" | "india"; horizon_days?: 2 | 5 | 10 | 20 };
    if (!challenger_id) return NextResponse.json({ error: "challenger_id required" }, { status: 400 });

    const supabase = createServiceClient();
    let resolvedMarket = market;
    if (!resolvedMarket) {
      const { data: row } = await supabase.from("strategy_versions").select("market").eq("id", challenger_id).maybeSingle();
      resolvedMarket = ((row as any)?.market ?? "us") as "us" | "india";
    }

    const result = await validateChallenger(supabase, { market: resolvedMarket, challengerId: challenger_id, horizonDays: horizon_days });
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
