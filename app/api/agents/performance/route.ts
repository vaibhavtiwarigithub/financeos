import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const svc = createServiceClient();

    // 1. NAV history ordered asc for chart
    const { data: navHistory } = await svc
      .from("paper_nav_history")
      .select("date, nav, cash_balance, open_positions, realized_pnl")
      .order("date", { ascending: true });

    // 2. Closed paper trades (outcome set OR closed_at set)
    const { data: allTrades } = await svc
      .from("paper_trades")
      .select("id, symbol, realized_pnl, pnl_pct, outcome, executed_at, closed_at, analyst_score, order_side")
      .order("executed_at", { ascending: false });

    const trades = (allTrades ?? []) as any[];
    const closedTrades = trades.filter(
      (t: any) => t.outcome != null || t.closed_at != null
    );
    const closedCount = closedTrades.length;

    // 3. Open positions count
    const { count: openCount } = await svc
      .from("paper_positions")
      .select("*", { count: "exact", head: true });

    // 4. Current portfolio nav + cash
    const { data: portfolioArr } = await svc
      .from("paper_portfolio")
      .select("nav, cash_balance")
      .limit(1);
    const portfolio = portfolioArr?.[0] ?? { nav: 10000, cash_balance: 10000 };
    const nav = Number(portfolio.nav ?? 10000);
    const cash = Number(portfolio.cash_balance ?? 10000);

    // 5. SPY price_cache for same date range as nav history
    const history = (navHistory ?? []) as any[];
    let spyReturn = 0;
    if (history.length >= 2) {
      const firstDate = history[0].date;
      const lastDate = history[history.length - 1].date;
      const { data: spyRows } = await svc
        .from("price_cache")
        .select("date, close")
        .eq("symbol", "SPY")
        .gte("date", firstDate)
        .lte("date", lastDate)
        .order("date", { ascending: true });
      const spy = (spyRows ?? []) as any[];
      if (spy.length >= 2) {
        const firstClose = Number(spy[0].close);
        const lastClose = Number(spy[spy.length - 1].close);
        spyReturn = firstClose > 0 ? ((lastClose / firstClose) - 1) * 100 : 0;
      }
    }

    // 6. Computed metrics
    const wins = closedTrades.filter((t: any) => t.outcome === "win").length;
    const winRate = closedCount > 0 ? (wins / closedCount) * 100 : 0;
    const avgReturn =
      closedCount > 0
        ? closedTrades.reduce((sum: number, t: any) => sum + (Number(t.pnl_pct) || 0), 0) / closedCount
        : 0;
    const totalPnl = closedTrades.reduce(
      (sum: number, t: any) => sum + (Number(t.realized_pnl) || 0),
      0
    );
    const paperReturn = ((nav / 10000) - 1) * 100;

    const gates = {
      minTrades: closedCount >= 10,
      winRate: winRate >= 55,
      positiveReturn: paperReturn > 0,
      beatsSpy: paperReturn > spyReturn,
    };
    const allGatesPassed = Object.values(gates).every(Boolean);

    return NextResponse.json({
      navHistory: history,
      trades: closedTrades,
      winRate,
      avgReturn,
      totalPnl,
      spyReturn,
      paperReturn,
      closedCount,
      openCount: openCount ?? 0,
      gates,
      allGatesPassed,
      nav,
      cash,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Was completely unauthenticated — any caller could write NAV snapshots via
  // the service-role client. Require cron secret or a logged-in user.
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "snapshot") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    const svc = createServiceClient();

    // Read current portfolio
    const { data: portfolioArr } = await svc
      .from("paper_portfolio")
      .select("nav, cash_balance")
      .limit(1);
    const portfolio = portfolioArr?.[0] ?? { nav: 10000, cash_balance: 10000 };
    const nav = Number(portfolio.nav ?? 10000);
    const cashBalance = Number(portfolio.cash_balance ?? 10000);

    // Count open positions
    const { count: openPositions } = await svc
      .from("paper_positions")
      .select("*", { count: "exact", head: true });

    // Sum realized pnl from closed trades
    const { data: closedRows } = await svc
      .from("paper_trades")
      .select("realized_pnl")
      .not("outcome", "is", null);
    const realizedPnl = (closedRows ?? []).reduce(
      (sum: number, t: any) => sum + (Number(t.realized_pnl) || 0),
      0
    );

    const today = new Date().toISOString().slice(0, 10);

    await svc.from("paper_nav_history").upsert(
      {
        date: today,
        nav,
        cash_balance: cashBalance,
        open_positions: openPositions ?? 0,
        realized_pnl: realizedPnl,
      },
      { onConflict: "date" }
    );

    return NextResponse.json({ snapshotted: true, nav, date: today });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
