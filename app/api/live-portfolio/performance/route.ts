import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const PERIOD_DAYS: Record<string, number> = {
  "1D": 2,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "YTD": -1, // computed below
  "1Y": 365,
  "All": 1825,
};

interface MassiveResult { t: number; o: number; h: number; l: number; c: number; v: number; }

// Daily close series via Massive (matches the rest of the app — Alpha Vantage's
// 25/day cap made a per-holding fetch here impossible: 26 holdings = 26 calls
// in one page load, before any other AV feature got a look-in).
async function fetchDailySeries(symbol: string, from: string, to: string, apiKey: string): Promise<Record<string, number>> {
  if (!apiKey) return {};
  try {
    const url = `https://api.massive.com/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${apiKey}`;
    // Daily bars only change once/day — 1h cache matches charts/symbol-history.
    const res = await fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 3600 } });
    if (!res.ok) return {};
    const data: { results?: MassiveResult[] } = await res.json();
    const result: Record<string, number> = {};
    for (const r of data.results ?? []) {
      result[new Date(r.t).toISOString().slice(0, 10)] = r.c;
    }
    return result;
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  const period = new URL(req.url).searchParams.get("period") ?? "1M";
  const massiveKey = process.env.MASSIVE_API_KEY ?? "";

  const accountIds = new URL(req.url).searchParams.get("accounts")?.split(",").filter(Boolean);
  const svc = createServiceClient();
  let q = svc.from("live_account_snapshots").select("*").order("captured_at", { ascending: false });
  if (accountIds && accountIds.length > 0) q = q.in("account_id", accountIds);
  const { data: snaps } = await q;

  if (!snaps || snaps.length === 0) return NextResponse.json({ dates: [], portfolio: [], holdings: [] });

  // Merge positions across accounts, aggregate same symbol
  const symMap: Record<string, { qty: number; cost: number }> = {};
  for (const snap of snaps) {
    for (const p of (Array.isArray(snap.positions_json) ? snap.positions_json : [])) {
      const qty = parseFloat(p.quantity ?? p.qty ?? "0");
      const avgCost = parseFloat(p.average_buy_price ?? p.avg_price ?? p.avg_cost ?? "0");
      if (!symMap[p.symbol]) symMap[p.symbol] = { qty: 0, cost: 0 };
      symMap[p.symbol].qty += qty;
      symMap[p.symbol].cost += qty * avgCost;
    }
  }

  const positions: any[] = Object.entries(symMap).map(([symbol, v]) => ({
    symbol, quantity: v.qty, average_buy_price: v.qty > 0 ? v.cost / v.qty : 0,
  }));
  if (positions.length === 0) return NextResponse.json({ dates: [], portfolio: [], holdings: [] });

  const now = new Date();
  let startDate: Date;
  if (period === "YTD") {
    startDate = new Date(now.getFullYear(), 0, 1);
  } else {
    const days = PERIOD_DAYS[period] ?? 30;
    startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = now.toISOString().slice(0, 10);

  // Fetch all holdings' series in parallel — Massive has no 25/day wall, and
  // each URL is independently cached for 1h, so repeat loads are free.
  const symbolSeries: Record<string, Record<string, number>> = {};
  await Promise.all(positions.map(async pos => {
    symbolSeries[pos.symbol] = await fetchDailySeries(pos.symbol, startStr, endStr, massiveKey);
  }));

  // Collect all dates in range across all series
  const allDates = new Set<string>();
  for (const series of Object.values(symbolSeries)) {
    for (const date of Object.keys(series)) {
      if (date >= startStr) allDates.add(date);
    }
  }
  const dates = Array.from(allDates).sort();
  if (dates.length === 0) return NextResponse.json({ dates: [], portfolio: [], holdings: [] });

  // Build per-holding % return series (normalized to 0 at start)
  const holdingSeries: { symbol: string; data: number[] }[] = [];
  const posWeights: { symbol: string; qty: number; avgCost: number }[] = positions.map(p => ({
    symbol: p.symbol,
    qty: parseFloat(p.quantity ?? p.qty ?? "1"),
    avgCost: parseFloat(p.average_buy_price ?? p.avg_cost ?? "0"),
  }));

  for (const pos of posWeights) {
    const series = symbolSeries[pos.symbol] ?? {};
    const firstPrice = series[dates[0]] ?? pos.avgCost;
    const data = dates.map(d => {
      const price = series[d];
      if (!price || !firstPrice) return null;
      return parseFloat(((price - firstPrice) / firstPrice * 100).toFixed(2));
    });
    // forward fill nulls
    let last = 0;
    const filled = data.map(v => { if (v !== null) { last = v; return v; } return last; });
    holdingSeries.push({ symbol: pos.symbol, data: filled });
  }

  // Portfolio combined: weighted by starting position value
  const totalCost = posWeights.reduce((s, p) => s + p.qty * p.avgCost, 0);
  const portfolio = dates.map((_, i) => {
    if (totalCost === 0) return 0;
    let weighted = 0;
    for (const pos of posWeights) {
      const series = holdingSeries.find(h => h.symbol === pos.symbol);
      if (!series) continue;
      const weight = (pos.qty * pos.avgCost) / totalCost;
      weighted += (series.data[i] ?? 0) * weight;
    }
    return parseFloat(weighted.toFixed(2));
  });

  return NextResponse.json({ dates, portfolio, holdings: holdingSeries });
}
