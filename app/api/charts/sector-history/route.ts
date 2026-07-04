import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const SYMBOLS = ["XLK","XLF","XLE","XLV","XLI","XLY","XLC","XLP","XLU","XLRE","XLB"];

interface MassiveResult {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

// Massive/Polygon paginates aggs responses via `next_url` regardless of the
// `limit` param — a single unpaginated fetch silently truncates any range
// longer than one page. This was why 1Y (365d) returned barely more rows than
// 3M (90d): both were hitting the same page-1 cap. Follow next_url like
// charts/symbol-history does.
async function fetchMassiveSymbol(
  sym: string, from: string, to: string, apiKey: string
): Promise<{ symbol: string; rows: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] }> {
  const rows: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let url: string | null =
    `https://api.massive.com/v2/aggs/ticker/${sym}/range/1/day/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;

  let pages = 0;
  while (url && pages < 20) {
    pages++;
    let res: Response = await fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 86400 } });
    // Free-tier Massive rate limit (429) — retry with backoff instead of
    // failing the whole symbol out of Promise.allSettled.
    for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      res = await fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 86400 } });
    }
    if (!res.ok) throw new Error(`Massive ${res.status} for ${sym}`);
    const data: { results?: MassiveResult[]; next_url?: string } = await res.json();
    for (const r of data.results ?? []) {
      rows.push({ symbol: sym, date: new Date(r.t).toISOString().slice(0, 10), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
    }
    url = data.next_url ? `${data.next_url}&apiKey=${apiKey}` : null;
  }
  return { symbol: sym, rows };
}

export async function GET(req: NextRequest) {
  const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "90"), 3650);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const today = new Date().toISOString().slice(0, 10);

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase
    .from("price_cache")
    .select("symbol, date, close")
    .in("symbol", SYMBOLS)
    .gte("date", cutoff)
    .order("symbol")
    .order("date", { ascending: true });

  // If cache is sufficiently populated, return it directly
  const minExpected = days * 0.5; // per symbol
  const cacheOk = !error && rows && rows.length >= minExpected;

  if (cacheOk) {
    const series: Record<string, { time: string; value: number }[]> = {};
    for (const row of rows!) {
      if (!series[row.symbol]) series[row.symbol] = [];
      series[row.symbol].push({ time: row.date, value: Number(row.close) });
    }
    return NextResponse.json({ series, stale: false, days, cutoff });
  }

  // Cache too sparse — fetch from Massive
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    // No API key — return whatever cache has
    if (rows && rows.length > 0) {
      const series: Record<string, { time: string; value: number }[]> = {};
      for (const row of rows) {
        if (!series[row.symbol]) series[row.symbol] = [];
        series[row.symbol].push({ time: row.date, value: Number(row.close) });
      }
      return NextResponse.json({ series, stale: true, days, cutoff });
    }
    return NextResponse.json({ series: {}, stale: true });
  }

  // Stagger start times — firing all 11 symbols at once trips the free-tier
  // per-minute rate limit (429s) and Promise.allSettled silently drops those.
  const results = await Promise.allSettled(
    SYMBOLS.map((sym, i) =>
      new Promise(r => setTimeout(r, i * 200)).then(() => fetchMassiveSymbol(sym, cutoff, today, apiKey))
    )
  );

  // Collect all fetched rows and build series
  const allRows: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  const series: Record<string, { time: string; value: number }[]> = {};

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { symbol: sym, rows: symRows } = result.value;
      allRows.push(...symRows);
      series[sym] = symRows.map(r => ({ time: r.date, value: r.close }));
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

  if (Object.keys(series).length === 0) {
    return NextResponse.json({ series: {}, stale: true });
  }

  return NextResponse.json({ series, stale: false, days, cutoff });
}
