import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

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

const BENCH_SYMBOL = "VOO"; // US live accounts benchmark (same index the paper US chart uses)

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

// Rebase an absolute value to cumulative % return from the first finite base.
function pctFrom(value: number | null, base: number | null): number | null {
  if (value == null || base == null || !base) return null;
  return parseFloat((((value - base) / base) * 100).toFixed(2));
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const period = new URL(req.url).searchParams.get("period") ?? "1M";
  const massiveKey = process.env.MASSIVE_API_KEY ?? "";
  const accountIds = new URL(req.url).searchParams.get("accounts")?.split(",").filter(Boolean);
  const svc = createServiceClient();

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

  const empty = { dates: [], portfolio: [], benchmark: [], holdings: [], estimated: false, benchSymbol: BENCH_SYMBOL };

  // ── REAL PATH: live_performance (durable, honest broker-equity curve) ──────
  // We accrue one row per account per day (equity + VOO close) from the snapshot
  // refresh. Once >=2 real days exist in the window for the selected accounts,
  // draw the TRUE equity curve; no estimation.
  {
    let lq = svc.from("live_performance").select("account_id, date, equity, bench_nav").gte("date", startStr).order("date", { ascending: true });
    if (accountIds && accountIds.length > 0) lq = lq.in("account_id", accountIds);
    const { data: real } = await lq;

    if (real && real.length > 0) {
      // Aggregate across selected accounts: sum equity per date, take the day's VOO.
      const byDate = new Map<string, { equity: number; bench: number | null }>();
      for (const r of real as any[]) {
        const d = String(r.date).slice(0, 10);
        const cur = byDate.get(d) ?? { equity: 0, bench: null };
        cur.equity += Number(r.equity ?? 0);
        if (r.bench_nav != null) cur.bench = Number(r.bench_nav);
        byDate.set(d, cur);
      }
      const dates = Array.from(byDate.keys()).sort();
      if (dates.length >= 2) {
        const equityBase = byDate.get(dates[0])!.equity;
        const firstBench = dates.map(d => byDate.get(d)!.bench).find(v => v != null) ?? null;
        const portfolio = dates.map(d => pctFrom(byDate.get(d)!.equity, equityBase) ?? 0);
        const benchmark = dates.map(d => pctFrom(byDate.get(d)!.bench, firstBench));
        return NextResponse.json({
          dates, portfolio, benchmark, holdings: [],
          estimated: false, benchSymbol: BENCH_SYMBOL, trackingSince: dates[0],
        });
      }
    }
  }

  // ── ESTIMATE PATH: constant-holdings backcast (labeled) ───────────────────
  // No real curve yet. Reconstruct an APPROXIMATE portfolio value using today's
  // holdings × each symbol's historical close. This ASSUMES the current share
  // counts were held throughout the window, so it distorts wherever positions
  // were opened/closed/resized — it's a rough shape, not real history. Flagged
  // `estimated:true` so the UI labels it. Overlays VOO for the same comparison.
  let q = svc.from("live_account_snapshots").select("*").order("captured_at", { ascending: false });
  if (accountIds && accountIds.length > 0) q = q.in("account_id", accountIds);
  const { data: snaps } = await q;
  if (!snaps || snaps.length === 0) return NextResponse.json(empty);

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
  if (positions.length === 0) return NextResponse.json(empty);

  // Fetch all holdings' series + the benchmark in parallel — Massive has no
  // 25/day wall, and each URL is independently cached for 1h.
  const symbolSeries: Record<string, Record<string, number>> = {};
  await Promise.all([
    ...positions.map(async pos => { symbolSeries[pos.symbol] = await fetchDailySeries(pos.symbol, startStr, endStr, massiveKey); }),
    (async () => { symbolSeries[BENCH_SYMBOL] = await fetchDailySeries(BENCH_SYMBOL, startStr, endStr, massiveKey); })(),
  ]);

  // Collect all dates in range across all HOLDING series (benchmark aligns to these)
  const allDates = new Set<string>();
  for (const [sym, series] of Object.entries(symbolSeries)) {
    if (sym === BENCH_SYMBOL) continue;
    for (const date of Object.keys(series)) {
      if (date >= startStr) allDates.add(date);
    }
  }
  const dates = Array.from(allDates).sort();
  if (dates.length === 0) return NextResponse.json(empty);

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

  // Benchmark (VOO) rebased to 0 at the first date that has a close.
  const benchRaw = symbolSeries[BENCH_SYMBOL] ?? {};
  const benchBase = dates.map(d => benchRaw[d]).find(v => v != null) ?? null;
  const benchmark = dates.map(d => pctFrom(benchRaw[d] ?? null, benchBase ?? null));

  return NextResponse.json({
    dates, portfolio, benchmark, holdings: holdingSeries,
    estimated: true, benchSymbol: BENCH_SYMBOL,
  });
}
