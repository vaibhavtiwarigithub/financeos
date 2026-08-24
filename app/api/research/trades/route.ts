// GET /api/research/trades?symbol=NVDA&market=us
// Returns raw paper lots plus a normalized decision/execution timeline. Paper
// exits update the original BUY lot, so the normalized timeline is the source
// for honest BUY/SELL display.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { liveDecisionEvents, paperTradeEvents } from "@/lib/research/trade-timeline";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const requestedMarket = req.nextUrl.searchParams.get("market")?.toLowerCase();
  const market = requestedMarket ?? (/\.(NS|BO)$/i.test(symbol) ? "india" : "us");
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const [paperResult, proposalResult, orderResult] = await Promise.all([
    supabase.from("paper_trades")
      .select("id,symbol,market,order_side,qty,fill_price,entry_price,exit_price,executed_at,exit_at,closed_at,realized_pnl_pct,pnl_pct,fundamental_score,technical_score,sentiment_score,macro_score,analyst_score,direction,rationale,exit_reason,tainted")
      .eq("symbol", symbol).eq("market", market)
      .or("tainted.is.null,tainted.is.false")
      .order("executed_at", { ascending: false }).limit(200),
    supabase.from("trade_proposals")
      .select("id,symbol,market,side,qty,status,created_at,price_at_proposal,analyst_score,thesis")
      .eq("symbol", symbol).eq("market", market)
      .order("created_at", { ascending: false }).limit(100),
    supabase.from("broker_orders")
      .select("id,symbol,market,side,qty,status,created_at,submitted_at,closed_at,avg_fill_price,filled_qty,error")
      .eq("symbol", symbol).eq("market", market)
      .order("created_at", { ascending: false }).limit(100),
  ]);

  const error = paperResult.error ?? proposalResult.error ?? orderResult.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const paperEvents = paperTradeEvents(paperResult.data ?? []);
  const liveEvents = liveDecisionEvents(proposalResult.data ?? [], orderResult.data ?? []);
  const events = [...paperEvents, ...liveEvents]
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, 300);

  return NextResponse.json({ symbol, market, trades: paperResult.data ?? [], events });
}
