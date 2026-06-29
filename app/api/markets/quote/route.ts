import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const apiKey = process.env.MASSIVE_API_KEY;

  // 1. Try Massive API prev-day bar
  if (apiKey) {
    try {
      const res = await fetch(
        `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${apiKey}`,
        { headers: { Accept: "application/json" }, next: { revalidate: 300 } }
      );
      if (res.ok) {
        const data = await res.json();
        const r = data.results?.[0];
        if (r) {
          return NextResponse.json({
            symbol, price: r.c,
            open: r.o, high: r.h, low: r.l, volume: r.v,
            change: r.c - r.o,
            changePct: ((r.c - r.o) / r.o) * 100,
            source: "massive",
          });
        }
      }
    } catch {
      // fall through
    }
  }

  // 2. Fallback: last price from price_cache
  const svc = createServiceClient();
  const { data } = await svc
    .from("price_cache")
    .select("date, open, high, low, close, volume")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(2);

  if (data && data.length > 0) {
    const cur = data[0];
    const prev = data[1];
    const price = Number(cur.close);
    const prevClose = prev ? Number(prev.close) : Number(cur.open);
    return NextResponse.json({
      symbol, price,
      open: Number(cur.open), high: Number(cur.high), low: Number(cur.low),
      volume: Number(cur.volume),
      change: price - prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      source: "cache",
    });
  }

  return NextResponse.json({ error: "No price data available" }, { status: 404 });
}
