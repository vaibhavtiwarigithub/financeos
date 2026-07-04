import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

interface MassiveResult {
  v: number; vw: number; o: number; c: number; h: number; l: number; t: number; n: number;
}

interface Candle {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

function msToDate(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

async function fetchFromMassive(symbol: string, from: string, to: string): Promise<Candle[]> {
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) throw new Error("MASSIVE_API_KEY not set");

  const candles: Candle[] = [];
  let url: string | null =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;

  let pages = 0;
  while (url && pages < 20) {
    pages++;
    // Was completely uncached — up to 20 paginated requests per symbol-page
    // view, on every load. Daily bars only change once per day; 1h keeps
    // today's bar reasonably fresh while cutting redundant calls drastically.
    const res: Response = await fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 3600 } });
    if (!res.ok) {
      const txt: string = await res.text();
      throw new Error(`Massive ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data: { results?: MassiveResult[]; next_url?: string } = await res.json();
    if (Array.isArray(data.results)) {
      for (const r of data.results as MassiveResult[]) {
        candles.push({ date: msToDate(r.t), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
      }
    }
    // Pagination: next_url already includes cursor — just append apiKey
    url = data.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
  }

  return candles;
}

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase().trim();
  const from = req.nextUrl.searchParams.get("from") ?? "2000-01-01";
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";

  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const svc = createServiceClient();
  const today = new Date().toISOString().split("T")[0];

  // 1. Try cache first (unless ?refresh=1)
  if (!refresh) {
    const { data: cached } = await svc
      .from("price_cache")
      .select("date, open, high, low, close, volume")
      .eq("symbol", symbol)
      .gte("date", from)
      .order("date", { ascending: true });

    if (cached && cached.length > 10) {
      const lastDate = cached[cached.length - 1].date as string;
      const stale = (Date.now() - new Date(lastDate).getTime()) / 86400000;
      if (stale <= 3) {
        return NextResponse.json({
          symbol, source: "cache",
          candles: cached.map((r: any) => ({
            date: r.date,
            open: Number(r.open), high: Number(r.high),
            low: Number(r.low), close: Number(r.close),
            volume: Number(r.volume),
          })),
        });
      }
    }
  }

  // 2. Fetch from Massive
  try {
    const candles = await fetchFromMassive(symbol, from, today);

    if (candles.length > 0) {
      const rows = candles.map(c => ({
        symbol, date: c.date,
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      // Batch upsert 500 rows at a time
      for (let i = 0; i < rows.length; i += 500) {
        await svc.from("price_cache").upsert(rows.slice(i, i + 500), { onConflict: "symbol,date" });
      }
    }

    return NextResponse.json({ symbol, source: "massive", candles });
  } catch (err) {
    // Fallback: return whatever cache we have
    const { data: fallback } = await svc
      .from("price_cache")
      .select("date, open, high, low, close, volume")
      .eq("symbol", symbol)
      .gte("date", from)
      .order("date", { ascending: true });

    if (fallback && fallback.length > 0) {
      return NextResponse.json({
        symbol, source: "cache_fallback",
        candles: fallback.map((r: any) => ({
          date: r.date,
          open: Number(r.open), high: Number(r.high),
          low: Number(r.low), close: Number(r.close),
          volume: Number(r.volume),
        })),
      });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
