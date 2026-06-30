import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

async function fetchQuote(symbol: string, apiKey: string | undefined) {
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
          return {
            symbol, price: r.c,
            open: r.o, high: r.h, low: r.l, volume: r.v,
            change: r.c - r.o,
            changePct: ((r.c - r.o) / r.o) * 100,
            source: "massive",
          };
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
    return {
      symbol, price,
      open: Number(cur.open), high: Number(cur.high), low: Number(cur.low),
      volume: Number(cur.volume),
      change: price - prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      source: "cache",
    };
  }

  return null;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = raw
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);

  if (symbols.length === 0) {
    return NextResponse.json({ error: "symbols required (comma-separated, max 20)" }, { status: 400 });
  }

  const apiKey = process.env.MASSIVE_API_KEY;

  const results = await Promise.allSettled(
    symbols.map(symbol => fetchQuote(symbol, apiKey))
  );

  const quotes: Record<string, { price: number; change: number; changePct: number } | null> = {};
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      const q = result.value;
      quotes[symbol] = { price: q.price, change: q.change, changePct: q.changePct };
    } else {
      quotes[symbol] = null;
    }
  }

  return NextResponse.json({ quotes });
}
