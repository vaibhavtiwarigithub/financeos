// GET /api/research/price?symbol=NVDA&days=365
// Returns OHLCV candles.
//
// Owner: fetchPriceHistory, which backfills from Alpha Vantage / Massive when
// price_cache is short. Viewer (Deep Dive): stored candles only, so opening a
// symbol can never spend provider budget. A symbol with no stored candles shows
// an empty chart rather than triggering a fetch.
import { NextRequest, NextResponse } from "next/server";
import { fetchPriceHistory } from "@/lib/chart-data";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireViewerOrOwner } from "@/lib/auth/session-role";

export async function GET(req: NextRequest) {
  const { gate, role } = await requireViewerOrOwner(req);
  if (gate) return gate;

  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "365");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const validDays = Math.min(Math.max(days, 30), 2000);

  if (role !== "owner") {
    const cutoff = new Date(Date.now() - validDays * 86_400_000).toISOString().slice(0, 10);
    // Paginated: PostgREST caps one response at 1,000 rows, so `.limit(2500)` silently returned the OLDEST 1,000 bars
    // for long windows (VOO has 1,304) and the chart ended years ago.
    const svc = createServiceClient();
    let data: any[];
    try {
      data = await fetchAllRows((from, to) => svc
        .from("price_cache")
        .select("date, open, high, low, close, volume")
        .eq("symbol", symbol)
        .gte("date", cutoff)
        .order("date", { ascending: true })
        .range(from, to), "stored price history");
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
    const candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = data
      .map((r: any) => ({
        date: String(r.date), open: Number(r.open), high: Number(r.high),
        low: Number(r.low), close: Number(r.close), volume: Number(r.volume ?? 0),
      }))
      .filter((c: { close: number }) => Number.isFinite(c.close));
    return NextResponse.json({ symbol, candles, source: "stored" });
  }

  const candles = await fetchPriceHistory(symbol, validDays);
  return NextResponse.json({ symbol, candles });
}
