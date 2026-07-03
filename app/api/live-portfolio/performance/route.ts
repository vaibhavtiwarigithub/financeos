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

async function fetchDailySeries(symbol: string, avKey: string): Promise<Record<string, number>> {
  if (!avKey) return {};
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${avKey}`;
    const r = await fetch(url, { next: { revalidate: 3600 } });
    const json = await r.json();
    const series = json["Time Series (Daily)"];
    if (!series) return {};
    const result: Record<string, number> = {};
    for (const [date, val] of Object.entries(series as Record<string, any>)) {
      result[date] = parseFloat(val["5. adjusted close"] ?? val["4. close"] ?? "0");
    }
    return result;
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  const period = new URL(req.url).searchParams.get("period") ?? "1M";
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";

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

  // Stagger AV calls 300ms apart to avoid rate limiting
  const symbolSeries: Record<string, Record<string, number>> = {};
  for (const pos of positions) {
    symbolSeries[pos.symbol] = await fetchDailySeries(pos.symbol, avKey);
    await new Promise(r => setTimeout(r, 300));
  }

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
