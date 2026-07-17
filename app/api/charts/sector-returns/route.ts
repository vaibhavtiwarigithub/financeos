import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { computeSectorReturns, summariseCoverage, type Candle } from "@/lib/markets/sector-returns";

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

// Massive/Polygon paginates aggs responses via `next_url` regardless of the
// `limit` param — a single unpaginated fetch silently truncates any range
// longer than one page (this was why longer periods returned barely more
// rows than shorter ones). Follow next_url like charts/symbol-history does.
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

// Span-aware return computation lives in `@/lib/markets/sector-returns` — it
// checks that the cached bars actually SPAN the requested window rather than
// merely counting >= 2 of them. See that module for the tolerance rationale.
function buildPayload(
  bySymbol: Record<string, Candle[]>,
  days: number,
  today: string,
  cutoff: string,
) {
  const sectors = computeSectorReturns(SECTORS, bySymbol, { days, today });
  const coverage = summariseCoverage(sectors);
  return { sectors, coverage, stale: false, days, cutoff };
}

export async function GET(req: NextRequest) {
  const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "90"), 365);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const today = new Date().toISOString().slice(0, 10);

  const supabase = createServiceClient();

  // Batch query for all 11 ETFs — PAGINATED.
  //
  // PostgREST caps a response at 1000 rows. A full 1Y window is ~273 sessions x
  // 11 ETFs = ~3000 rows, so an unpaginated read silently returns only the
  // first 1000 — i.e. the four alphabetically-first sectors (XLB, XLC, XLE,
  // XLF) complete and the remaining seven with ZERO rows. This was latent while
  // the cache held only two sessions per symbol (22 rows total) and surfaced the
  // moment real history landed: the 1Y tab reported no_data for XLI/XLK/XLP/
  // XLRE/XLU/XLV/XLY purely because of the cap. Page until the source is drained.
  const PAGE = 1000;
  const rows: { symbol: string; date: string; close: number }[] = [];
  let error: unknown = null;
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error: pageErr } = await supabase
      .from("price_cache")
      .select("symbol, date, close")
      .in("symbol", SYMBOLS)
      .gte("date", cutoff)
      .order("symbol")
      .order("date", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (pageErr) { error = pageErr; break; }
    rows.push(...((page ?? []) as { symbol: string; date: string; close: number }[]));
    if (!page || page.length < PAGE) break;
    // Hard stop — the sector universe cannot legitimately exceed this.
    if (offset > 50_000) break;
  }

  // Cache has data — serve it. Sparse coverage is NOT silently averaged over:
  // any window the cached span cannot support reports null + an explicit reason
  // instead of a shorter move mislabelled as the requested period.
  if (!error && rows && rows.length > 0) {
    const bySymbol: Record<string, Candle[]> = {};
    for (const row of rows) {
      if (!bySymbol[row.symbol]) bySymbol[row.symbol] = [];
      bySymbol[row.symbol].push({ date: row.date, close: Number(row.close) });
    }
    return NextResponse.json(buildPayload(bySymbol, days, today, cutoff));
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

  // Stagger start times — firing all 11 symbols at once trips the free-tier
  // per-minute rate limit (429s) and Promise.allSettled silently drops those.
  const results = await Promise.allSettled(
    SYMBOLS.map((sym, i) =>
      new Promise(r => setTimeout(r, i * 200)).then(() => fetchMassiveSymbol(sym, cutoff, today, apiKey))
    )
  );

  const allRows: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  const bySymbol: Record<string, Candle[]> = {};

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

  return NextResponse.json(buildPayload(bySymbol, days, today, cutoff));
}
