// GET /api/research/fundamentals/cached?symbol=NVDA&market=us
//
// Stored fundamentals for the Deep Dive page, safe for viewers. The parent
// `/api/research/fundamentals` calls Finnhub / FMP / Alpha Vantage when its
// cache is stale, so a viewer opening a symbol could spend provider budget.
// This returns only the TTM overview research already stored in
// fundamental_facts — the same values the Fundamentals page shows.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireViewerOrOwner } from "@/lib/auth/session-role";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;

  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const requestedMarket = req.nextUrl.searchParams.get("market")?.toLowerCase();
  const market = requestedMarket ?? (/\.(NS|BO)$/i.test(symbol) ? "india" : "us");
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }

  let query = createServiceClient()
    .from("fundamental_facts")
    .select("values")
    .eq("symbol", symbol)
    .eq("is_latest", true)
    .eq("metric_set", "ttm_overview");
  // Older US rows predate the market column.
  query = market === "us" ? query.or("market.eq.us,market.is.null") : query.eq("market", market);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    symbol,
    market,
    overview: (data?.values as Record<string, string> | undefined) ?? {},
    source: data ? "stored" : "none",
  });
}
