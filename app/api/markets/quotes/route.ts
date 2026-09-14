import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveSymbolPair } from "@/lib/markets/price-cache-sessions";

export const dynamic = "force-dynamic";

// CACHE-ONLY. This route used to call the provider's previous-day aggregate per
// symbol behind a 5-minute fetch cache, falling back to `price_cache` only on
// failure. That was backwards: the value served IS a daily close, so the
// provider was being polled up to ~288 times a day for a number that moves once.
//
// `kairos-price-cache-fill` already writes every symbol this route is asked for
// (its universe covers the regime, sector and leveraged lists) in ONE grouped
// provider call per session. So the cache is now the only source, and the daily
// fill is the only thing that talks to a provider. WatchlistPanel's own comment
// already claimed "hits price_cache, no AI" — this makes that true.
//
// A symbol absent from the cache returns null rather than triggering a fetch:
// the fill has a freshness contract and `kairos-stale-check` alerts on it, so a
// gap is a monitored failure, not something to paper over per request.
async function fetchQuote(symbol: string) {
  const svc = createServiceClient();
  const { data } = await svc
    .from("price_cache")
    .select("date, open, high, low, close, volume")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(2);

  const rows = (data ?? []) as Array<Record<string, any>>;
  const pair = resolveSymbolPair(rows.map((r) => ({ symbol, date: String(r.date), close: r.close })));
  if (!pair) return null;

  const cur = rows.find((r) => String(r.date).slice(0, 10) === pair.date) ?? rows[0];
  // No prior session cached yet: fall back to the session's own open so the
  // change is at least a real intraday move rather than a fabricated zero.
  const prevClose = pair.priorClose ?? Number(cur.open);
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null;

  return {
    symbol,
    price: pair.close,
    open: Number(cur.open), high: Number(cur.high), low: Number(cur.low),
    volume: Number(cur.volume),
    change: pair.close - prevClose,
    changePct: ((pair.close - prevClose) / prevClose) * 100,
    source: "cache",
    sessionDate: pair.date,
  };
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

  const results = await Promise.allSettled(symbols.map((symbol) => fetchQuote(symbol)));

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
