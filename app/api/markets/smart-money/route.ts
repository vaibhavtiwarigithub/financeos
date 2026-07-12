import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// Client data source for the Smart Money tab (merged into the Intelligence
// page). Mirrors the queries the old /dashboard/smart-money server page ran,
// scoped to the selected market (?market=us|india). Owner-gated + service
// client because agent_signals / trade_proposals are not client-readable.
//
// Every market-scoped query is resilient: if the `market` column doesn't
// exist yet (pre-057) the filtered query errors, so we retry unscoped and
// fall back to the US path unchanged.
async function selectScoped<T>(
  run: (applyMarket: boolean) => PromiseLike<{ data: T | null; error: unknown }>
): Promise<T | null> {
  const withFilter = await run(true);
  if (!withFilter.error) return withFilter.data;
  const unscoped = await run(false);
  return unscoped.data;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [signals, tradeQueue, highInsider] = await Promise.all([
    selectScoped<any[]>((applyMarket) => {
      let q = svc
        .from("agent_signals")
        .select("symbol,direction,analyst_score,insider_score,technical_score,fundamental_score,sentiment_score,macro_score,created_at,asset_class,source")
        .gte("created_at", since30);
      if (applyMarket) q = q.eq("market", market);
      return q.order("analyst_score", { ascending: false }).limit(60);
    }),
    selectScoped<any[]>((applyMarket) => {
      // trade_proposals — the canonical table /api/agents/trader and the
      // Execution Gateway operate on. Aliased to the field names the UI expects.
      let q = svc
        .from("trade_proposals")
        .select("id, symbol, order_side:side, qty, limit_price, analyst_score, rationale:thesis, status, created_at, account_number")
        .in("status", ["pending_review", "approved", "executed", "rejected", "pending_approval"]);
      if (applyMarket) q = q.eq("market", market); // no market column on trade_proposals yet — resiliently falls back unscoped
      return q.order("created_at", { ascending: false }).limit(30);
    }),
    selectScoped<any[]>((applyMarket) => {
      let q = svc
        .from("agent_signals")
        .select("symbol,analyst_score,insider_score,direction,created_at,asset_class")
        .gte("created_at", since7)
        .gte("insider_score", 55);
      if (applyMarket) q = q.eq("market", market);
      return q.order("insider_score", { ascending: false }).limit(20);
    }),
  ]);

  return NextResponse.json({
    signals: signals ?? [],
    tradeQueue: tradeQueue ?? [],
    highInsider: highInsider ?? [],
    market,
  });
}
