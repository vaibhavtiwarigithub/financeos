import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const revalidate = 1800;

const SECTOR_ETFS = ["XLK","XLF","XLE","XLI","XLV","XLU","XLRE","XLC","XLY","XLP","XLB"];

interface Holding {
  symbol: string;
  weightPct: number;
  changePct: number;
  contribution: number;
}

async function getEtfHoldings(sector: string, avKey: string): Promise<{ symbol: string; weightPct: number }[]> {
  const url = `https://www.alphavantage.co/query?function=ETF_PROFILE&symbol=${sector}&apikey=${avKey}`;
  const res = await fetch(url, { next: { revalidate: 86400 } });
  if (!res.ok) throw new Error(`ETF_PROFILE fetch failed: ${res.status}`);
  const data = await res.json();

  if (!data.holdings || !Array.isArray(data.holdings)) {
    throw new Error("No holdings in ETF_PROFILE response");
  }

  const parsed = data.holdings
    .map((h: { symbol?: string; asset?: string; weight?: string }) => {
      const sym = (h.symbol || h.asset || "").toUpperCase().trim();
      const raw = (h.weight || "0").replace("%", "").trim();
      const weightPct = parseFloat(raw) || 0;
      return { symbol: sym, weightPct };
    })
    .filter((h: { symbol: string; weightPct: number }) => h.symbol && h.weightPct > 0)
    .sort((a: { symbol: string; weightPct: number }, b: { symbol: string; weightPct: number }) => b.weightPct - a.weightPct)
    .slice(0, 20);

  return parsed;
}

async function getQuote(symbol: string, massiveKey: string): Promise<{ changePct: number; ok: boolean }> {
  const url = `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${massiveKey}`;
  const res = await fetch(url, { next: { revalidate: 900 } });
  if (!res.ok) return { changePct: 0, ok: false };
  const data = await res.json();
  const result = data?.results?.[0];
  if (!result || !result.o || result.o === 0) return { changePct: 0, ok: false };
  const changePct = ((result.c - result.o) / result.o) * 100;
  return { changePct, ok: true };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sector = (searchParams.get("sector") || "XLK").toUpperCase();

  if (!SECTOR_ETFS.includes(sector)) {
    return NextResponse.json({ error: "Invalid sector ETF" }, { status: 400 });
  }

  // On weekends (Sat=6, Sun=0), markets are closed — serve most recent cached breadth
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    const supabase = createServiceClient();
    const { data: cached } = await supabase
      .from("sector_breadth_history")
      .select("date, breadth_pct, advance_count, decline_count, unchanged_count, top_contributors")
      .eq("sector", sector)
      .order("date", { ascending: false })
      .limit(1)
      .single();

    const { data: historyRows } = await supabase
      .from("sector_breadth_history")
      .select("date, breadth_pct")
      .eq("sector", sector)
      .order("date", { ascending: true })
      .limit(30);

    if (cached) {
      const top = JSON.parse(cached.top_contributors ?? "[]") as Holding[];
      return NextResponse.json({
        sector,
        holdings: top,
        topContributors: top.slice(0, 5),
        topDetractors: top.slice(-5).reverse(),
        advanceCount: cached.advance_count ?? 0,
        declineCount: cached.decline_count ?? 0,
        unchangedCount: cached.unchanged_count ?? 0,
        total: (cached.advance_count ?? 0) + (cached.decline_count ?? 0) + (cached.unchanged_count ?? 0),
        breadthPct: parseFloat(cached.breadth_pct) || 0,
        narrowTag: (parseFloat(cached.breadth_pct) < 40 ? "NARROW" : parseFloat(cached.breadth_pct) > 65 ? "BROAD" : "MIXED"),
        breadthHistory: (historyRows || []).map((r: any) => ({ date: r.date, breadth_pct: parseFloat(r.breadth_pct) || 0 })),
        topExplainPct: 0,
        _cached: true,
        _cachedDate: cached.date,
      });
    }
  }

  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  const massiveKey = process.env.MASSIVE_API_KEY;

  if (!avKey || !massiveKey) {
    return NextResponse.json(
      {
        sector,
        holdings: [],
        topContributors: [],
        topDetractors: [],
        advanceCount: 0,
        declineCount: 0,
        total: 0,
        breadthPct: 0,
        narrowTag: "MIXED",
        breadthHistory: [],
        topExplainPct: 0,
        error: "Missing API keys: ALPHA_VANTAGE_API_KEY or MASSIVE_API_KEY",
      },
      { status: 200 }
    );
  }

  try {
    // 1. Get ETF holdings
    const rawHoldings = await getEtfHoldings(sector, avKey);

    // 2. Get quotes in parallel
    const quotes = await Promise.all(
      rawHoldings.map((h) => getQuote(h.symbol, massiveKey))
    );

    // 3. Compute contributions — ONLY for holdings whose quote actually
    // succeeded. A failed fetch previously defaulted to changePct:0 and still
    // populated topContributors/topDetractors, showing every constituent as a
    // fake "flat 0.000%" mover instead of being excluded like a real failure.
    const holdings: Holding[] = rawHoldings
      .map((h, i) => ({
        symbol: h.symbol,
        weightPct: h.weightPct,
        changePct: quotes[i].changePct,
        contribution: (h.weightPct * quotes[i].changePct) / 100,
        _ok: quotes[i].ok,
      }))
      .filter(h => h._ok)
      .map(({ _ok, ...h }) => h);

    // 4. Sort by contribution
    const sorted = [...holdings].sort((a, b) => b.contribution - a.contribution);
    const topContributors = sorted.slice(0, 5);
    const topDetractors = sorted.slice(-5).reverse();

    // 5. A/D counts — `holdings` is already filtered to quote-fetch successes
    // above, so this is just those. Previously a failed fetch silently
    // returned changePct:0 and was counted as "unchanged", inflating `total`
    // and diluting breadthPct (e.g. 6 advancing / 4 declining out of 10 real
    // quotes showed as "30%" because 10 more holdings with failed quotes
    // were folded into a total of 20).
    const advanceCount = holdings.filter((h) => h.changePct > 0).length;
    const declineCount = holdings.filter((h) => h.changePct < 0).length;
    const unchangedCount = holdings.length - advanceCount - declineCount;
    const total = holdings.length;
    const breadthPct = total > 0 ? (advanceCount / total) * 100 : 0;

    const narrowTag =
      breadthPct < 40 ? "NARROW" : breadthPct > 65 ? "BROAD" : "MIXED";

    // 6. topExplainPct — top 3 absolute contributions vs total ETF move
    const top3AbsSum = sorted
      .slice(0, 3)
      .reduce((acc, h) => acc + Math.abs(h.contribution), 0);
    const totalAbsMove = holdings.reduce(
      (acc, h) => acc + Math.abs(h.contribution),
      0
    );
    const topExplainPct =
      totalAbsMove > 0 ? (top3AbsSum / totalAbsMove) * 100 : 0;

    // 7. Upsert today's breadth data to Supabase
    const supabase = createServiceClient();
    const today = new Date().toISOString().split("T")[0];

    await supabase.from("sector_breadth_history").upsert(
      {
        date: today,
        sector,
        advance_count: advanceCount,
        decline_count: declineCount,
        unchanged_count: unchangedCount,
        breadth_pct: Math.round(breadthPct * 100) / 100,
        top_contributors: JSON.stringify([...topContributors, ...topDetractors]),
      },
      { onConflict: "date,sector" }
    );

    // 8. Fetch last 30 days history
    const { data: historyRows } = await supabase
      .from("sector_breadth_history")
      .select("date, breadth_pct")
      .eq("sector", sector)
      .order("date", { ascending: true })
      .limit(30);

    const breadthHistory = (historyRows || []).map((r: any) => ({
      date: r.date,
      breadth_pct: parseFloat(r.breadth_pct) || 0,
    }));

    return NextResponse.json({
      sector,
      holdings,
      topContributors,
      topDetractors,
      advanceCount,
      declineCount,
      unchangedCount,
      total,
      breadthPct: Math.round(breadthPct * 100) / 100,
      narrowTag,
      breadthHistory,
      topExplainPct: Math.round(topExplainPct * 10) / 10,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        sector,
        holdings: [],
        topContributors: [],
        topDetractors: [],
        advanceCount: 0,
        declineCount: 0,
        total: 0,
        breadthPct: 0,
        narrowTag: "MIXED",
        breadthHistory: [],
        topExplainPct: 0,
        error: message,
      },
      { status: 200 }
    );
  }
}
