import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const SECTORS = [
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLF", name: "Financials" },
  { symbol: "XLE", name: "Energy" },
  { symbol: "XLV", name: "Healthcare" },
  { symbol: "XLI", name: "Industrials" },
  { symbol: "XLY", name: "Consumer Disc." },
  { symbol: "XLC", name: "Comm. Services" },
  { symbol: "XLP", name: "Consumer Staples" },
  { symbol: "XLU", name: "Utilities" },
  { symbol: "XLRE", name: "Real Estate" },
  { symbol: "XLB", name: "Materials" },
];

const SYMBOLS = SECTORS.map(s => s.symbol);

interface MassiveResult {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

async function fetchMassiveSymbol(
  sym: string, from: string, to: string, apiKey: string
): Promise<{ symbol: string; rows: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] }> {
  const url =
    `https://api.massive.com/v2/aggs/ticker/${sym}/range/1/day/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate: 86400 },
  });
  if (!res.ok) throw new Error(`Massive ${res.status} for ${sym}`);
  const data: { results?: MassiveResult[] } = await res.json();
  const rows = (data.results ?? []).map(r => ({
    symbol: sym,
    date: new Date(r.t).toISOString().slice(0, 10),
    open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v,
  }));
  return { symbol: sym, rows };
}

function computeReturns(
  bySymbol: Record<string, { date: string; close: number }[]>
) {
  return SECTORS.map(s => {
    const candles = bySymbol[s.symbol] ?? [];
    if (candles.length < 2) return { symbol: s.symbol, name: s.name, returnPct: null, candles: 0 };
    const first = candles[0].close;
    const last = candles[candles.length - 1].close;
    return {
      symbol: s.symbol,
      name: s.name,
      returnPct: ((last - first) / first) * 100,
      latestClose: last,
      candles: candles.length,
    };
  });
}

export async function GET(req: NextRequest) {
  const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "90"), 365);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const today = new Date().toISOString().slice(0, 10);

  const supabase = createServiceClient();

  // Single batch query for all 11 ETFs
  const { data: rows, error } = await supabase
    .from("price_cache")
    .select("symbol, date, close")
    .in("symbol", SYMBOLS)
    .gte("date", cutoff)
    .order("symbol")
    .order("date", { ascending: true });

  // Cache has data — use it even if sparse (bar chart: prefer speed over completeness)
  if (!error && rows && rows.length > 0) {
    const bySymbol: Record<string, { date: string; close: number }[]> = {};
    for (const row of rows) {
      if (!bySymbol[row.symbol]) bySymbol[row.symbol] = [];
      bySymbol[row.symbol].push({ date: row.date, close: Number(row.close) });
    }
    return NextResponse.json({ sectors: computeReturns(bySymbol), stale: false, days, cutoff });
  }

  // Cache is empty — fetch from Massive
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      sectors: [],
      stale: true,
      message: "Price cache empty — will populate after next agent run",
    });
  }

  const results = await Promise.allSettled(
    SYMBOLS.map(sym => fetchMassiveSymbol(sym, cutoff, today, apiKey))
  );

  const allRows: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  const bySymbol: Record<string, { date: string; close: number }[]> = {};

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { symbol: sym, rows: symRows } = result.value;
      allRows.push(...symRows);
      bySymbol[sym] = symRows.map(r => ({ date: r.date, close: r.close }));
    }
  }

  // Upsert to cache (batched)
  if (allRows.length > 0) {
    for (let i = 0; i < allRows.length; i += 500) {
      await supabase
        .from("price_cache")
        .upsert(allRows.slice(i, i + 500), { onConflict: "symbol,date", ignoreDuplicates: false });
    }
  }

  if (Object.keys(bySymbol).length === 0) {
    return NextResponse.json({
      sectors: [],
      stale: true,
      message: "Price cache empty — will populate after next agent run",
    });
  }

  return NextResponse.json({ sectors: computeReturns(bySymbol), stale: false, days, cutoff });
}
