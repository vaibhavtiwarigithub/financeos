import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ponytail: Mkt duplicated from lib/format-money to avoid importing a UI helper
// into an API route. If Mkt is ever exported from a shared types file, use that.
type Mkt = "us" | "india";
const SEED: Record<Mkt, number> = { us: 10_000, india: 1_000_000 };

interface Trade {
  symbol: string;
  closed_at: string;
  analyst_score: number | null;
  fill_price: number;
  exit_price: number;
  sector: string | null;
  return_pct: number;
}

interface NavPoint { date: string; nav: number }
interface LaneStats {
  winRate: number;
  totalReturn: number;
  tradeCount: number;
  avgReturn: number;
  maxDrawdown: number;
}

// Walk trades chronologically, compound NAV, collect stats.
// maxDrawdown is the largest peak-to-trough decline as a positive percentage.
function buildNavCurve(
  trades: Trade[],
  seed: number
): { navHistory: NavPoint[]; stats: LaneStats } {
  if (trades.length === 0) {
    return {
      navHistory: [],
      stats: { winRate: 0, totalReturn: 0, tradeCount: 0, avgReturn: 0, maxDrawdown: 0 },
    };
  }
  const navHistory: NavPoint[] = [];
  let nav = seed;
  let peakNav = seed;
  let maxDD = 0;
  let wins = 0;

  for (const t of trades) {
    nav = nav * (1 + t.return_pct / 100);
    navHistory.push({ date: t.closed_at.slice(0, 10), nav });
    if (nav > peakNav) peakNav = nav;
    const dd = (peakNav - nav) / peakNav * 100;
    if (dd > maxDD) maxDD = dd;
    if (t.return_pct > 0) wins++;
  }

  const avgReturn = trades.reduce((s, t) => s + t.return_pct, 0) / trades.length;

  return {
    navHistory,
    stats: {
      winRate: (wins / trades.length) * 100,
      totalReturn: ((nav / seed) - 1) * 100,
      tradeCount: trades.length,
      avgReturn,
      maxDrawdown: maxDD,
    },
  };
}

// 500-shuffle Monte Carlo on champion trades.
// Date axis is the original (unshuffled) champion date sequence — shuffling
// changes the order of returns but the time axis stays anchored to real dates.
function runMonteCarlo(
  trades: Trade[],
  seed: number,
  n: number
): { p5: NavPoint[]; p50: NavPoint[]; p95: NavPoint[]; finalNavDist: number[] } {
  const T = trades.length;
  if (T === 0) return { p5: [], p50: [], p95: [], finalNavDist: [] };

  const dates = trades.map(t => t.closed_at.slice(0, 10));
  const returns = trades.map(t => t.return_pct);

  // navMatrix[t] = NAV values at time step t across all n runs
  const navMatrix: number[][] = Array.from({ length: T }, () => []);

  for (let i = 0; i < n; i++) {
    const shuffled = [...returns];
    // Fisher-Yates
    for (let j = T - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    let nav = seed;
    for (let t = 0; t < T; t++) {
      nav = nav * (1 + shuffled[t] / 100);
      navMatrix[t].push(nav);
    }
  }

  const percentile = (arr: number[], p: number): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  };

  const p5: NavPoint[] = [];
  const p50: NavPoint[] = [];
  const p95: NavPoint[] = [];

  for (let t = 0; t < T; t++) {
    p5.push({ date: dates[t], nav: percentile(navMatrix[t], 5) });
    p50.push({ date: dates[t], nav: percentile(navMatrix[t], 50) });
    p95.push({ date: dates[t], nav: percentile(navMatrix[t], 95) });
  }

  return { p5, p50, p95, finalNavDist: navMatrix[T - 1] };
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  try {
    const svc = createServiceClient();
    const market: Mkt =
      new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
    const seed = SEED[market];

    // Schema note: the paper exit RPC (execute_paper_exit) UPDATES the original
    // buy lot with exit_price + closed_at + outcome; it does NOT insert a sell
    // row. So closed trades are order_side='buy' rows where closed_at IS NOT NULL.
    // The task spec used order_side='sell' which matches the conceptual model but
    // not the actual schema — corrected here.
    const { data: rawTrades, error } = await svc
      .from("paper_trades")
      .select(
        "symbol, closed_at, executed_at, realized_pnl, analyst_score, qty, fill_price, exit_price"
      )
      .eq("market", market)
      .not("closed_at", "is", null)
      .gt("fill_price", 0)
      .gt("exit_price", 0)
      .order("closed_at", { ascending: true });

    if (error) throw error;

    const rows = (rawTrades ?? []) as any[];

    // Sector lookup: paper_positions is deleted on full close, so sector lives in
    // symbol_profiles (migration 20260715150000) keyed by (symbol, market).
    const symbols = [...new Set(rows.map((r: any) => r.symbol as string))];
    const sectorMap: Record<string, string | null> = {};
    if (symbols.length > 0) {
      const { data: profiles } = await svc
        .from("symbol_profiles")
        .select("symbol, sector")
        .eq("market", market)
        .in("symbol", symbols);
      for (const p of profiles ?? []) {
        sectorMap[p.symbol] = p.sector ?? null;
      }
    }

    const trades: Trade[] = rows.map((r: any) => {
      const fill = Number(r.fill_price);
      const exit = Number(r.exit_price);
      return {
        symbol: r.symbol,
        closed_at: r.closed_at,
        analyst_score: r.analyst_score != null ? Number(r.analyst_score) : null,
        fill_price: fill,
        exit_price: exit,
        sector: sectorMap[r.symbol] ?? null,
        return_pct: fill > 0 ? ((exit - fill) / fill) * 100 : 0,
      };
    });

    // Three lanes from the same trade list with different filters
    const champion = trades;
    const high_conviction = trades.filter(
      t => t.analyst_score != null && t.analyst_score >= 75
    );
    // Case-insensitive ETF exclusion — 'etf' and 'etfs' are the two variants seen
    const no_etf = trades.filter(
      t => !["etf", "etfs"].includes((t.sector ?? "").toLowerCase())
    );

    const LANES = [
      {
        id: "champion" as const,
        label: "Champion",
        description: "All closed trades",
        color: "#6366F1",
        trades: champion,
      },
      {
        id: "high_conviction" as const,
        label: "High Conviction",
        description: "Trades with analyst score ≥ 75",
        color: "#34D399",
        trades: high_conviction,
      },
      {
        id: "no_etf" as const,
        label: "No ETF",
        description: "Excluding ETF-sector trades",
        color: "#FBBF24",
        trades: no_etf,
      },
    ];

    const lanes = LANES.map(({ id, label, description, color, trades: lt }) => {
      const { navHistory, stats } = buildNavCurve(lt, seed);
      return { id, label, description, color, navHistory, stats };
    });

    const monteCarlo = runMonteCarlo(champion, seed, 500);

    return NextResponse.json({ market, seed, lanes, monteCarlo });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
