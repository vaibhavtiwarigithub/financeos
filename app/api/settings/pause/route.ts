import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { setMarketPaused } from "@/lib/market-controls";

export const dynamic = "force-dynamic";

// Pause/resume NEW ENTRIES. Two scopes:
//   - GLOBAL master (no `market`): strategy_config.app_paused — stops BOTH markets.
//   - PER-MARKET (`market: "us"|"india"`): market_controls row — stops only that
//     market (migration 171). A market is paused if the global master OR its own
//     row is set (see lib/market-controls.isPaused).
export async function GET() {
  const svc = createServiceClient();
  const [{ data: global }, { data: markets }] = await Promise.all([
    svc.from("strategy_config").select("app_paused, paused_at, paused_reason").limit(1).maybeSingle(),
    svc.from("market_controls").select("market, paused, paused_reason, paused_at").order("market"),
  ]);
  return NextResponse.json({
    app_paused: (global as any)?.app_paused ?? false,
    paused_at: (global as any)?.paused_at ?? null,
    paused_reason: (global as any)?.paused_reason ?? null,
    markets: markets ?? [],
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const paused = Boolean(body.paused);
  const reason = body.reason ?? null;
  const market = body.market === "us" || body.market === "india" ? body.market : null;
  const svc = createServiceClient();

  // Per-market pause/resume — only touches that market's control row.
  if (market) {
    await setMarketPaused(svc, market, paused, reason);
    return NextResponse.json({ ok: true, scope: market, paused });
  }

  // Global master pause/resume (both markets).
  const { data: config } = await svc.from("strategy_config").select("id").limit(1).single();
  if (!config) return NextResponse.json({ error: "No config" }, { status: 404 });
  await svc.from("strategy_config").update({
    app_paused: paused,
    paused_at: paused ? new Date().toISOString() : null,
    paused_reason: reason,
    updated_at: new Date().toISOString(),
  } as any).eq("id", (config as any).id);

  return NextResponse.json({ ok: true, scope: "global", app_paused: paused });
}
