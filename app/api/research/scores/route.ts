// GET /api/research/scores?symbol=STM&market=us&days=365
//
// Per-dimension score history for ANY researched symbol.
//
// WHY THIS EXISTS. The Score History tab read `/api/research/trades`, whose
// scores live as columns on the `paper_trades` row — so a symbol only had a
// score history if it had produced a TRADE. Research runs on hundreds of
// symbols that never trade, and every one of those runs already writes the full
// dimension set to `agent_signals`. STM, for instance, had 56 runs and 0 paper
// trades, so the page said "no scored paper trades found" while two months of
// scores sat in the database (observed 2026-09-15).
//
// `agent_signals` is the right source: it is written once per research run per
// symbol, trade or no trade. This route reads it and nothing else.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { toScorePoints } from "@/lib/research/score-history";

export const dynamic = "force-dynamic";

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

  const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("days") ?? "365", 10) || 365, 30), 2000);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("agent_signals")
    .select(
      "created_at,analyst_score,fundamental_score,technical_score,sentiment_score," +
      "macro_score,insider_score,direction,conviction,score_source,scoring_version",
    )
    .eq("symbol", symbol)
    .eq("market", market)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(2000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const points = toScorePoints(rows);

  return NextResponse.json({
    symbol,
    market,
    days,
    // `runs` counts research runs; `points` counts DAYS, which is smaller
    // whenever a symbol was researched more than once in a day. Reporting only
    // one of them would overstate or understate how much evidence there is.
    runs: rows.length,
    points,
  });
}
