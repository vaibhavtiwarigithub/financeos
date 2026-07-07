import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const svc = createServiceClient();

    // This dashboard is the US ($) paper book — SPY benchmark, $10k baseline.
    // Every aggregate MUST be scoped to market='us' or India (₹) rows corrupt the
    // win rate / avg return / P&L / position count. Resilient: fall back to
    // unscoped pre-057 (US-only world). paper_nav_history is written only by the
    // US nav-snapshot cron, so it needs no market filter.
    const usTrades = async () => {
      const cols = "id, symbol, realized_pnl, pnl_pct, outcome, executed_at, closed_at, analyst_score, order_side";
      let r = await svc.from("paper_trades").select(cols).eq("market", "us").order("executed_at", { ascending: false });
      if (r.error) r = await svc.from("paper_trades").select(cols).order("executed_at", { ascending: false });
      return r.data ?? [];
    };
    const usOpenCount = async () => {
      let r = await svc.from("paper_positions").select("*", { count: "exact", head: true }).eq("market", "us");
      if (r.error) r = await svc.from("paper_positions").select("*", { count: "exact", head: true });
      return r.count ?? 0;
    };

    // 1. NAV history ordered asc for chart (US-only by write path)
    const { data: navHistory } = await svc
      .from("paper_nav_history")
      .select("date, nav, cash_balance, open_positions, realized_pnl")
      .order("date", { ascending: true });

    // 2. Closed paper trades (US only)
    const trades = (await usTrades()) as any[];
    const closedTrades = trades.filter(
      (t: any) => t.outcome != null || t.closed_at != null
    );
    const closedCount = closedTrades.length;

    // 3. Open positions count (US only)
    const openCount = await usOpenCount();

    // 4. Current portfolio nav + cash
    // Phase 4: prefer the US pool; fall back to any row pre-057 (no market column)
    let { data: portfolio } = await svc.from("paper_portfolio").select("nav, cash_balance").eq("market", "us").limit(1).maybeSingle();
    if (!portfolio) ({ data: portfolio } = await svc.from("paper_portfolio").select("nav, cash_balance").limit(1).maybeSingle());
    portfolio = portfolio ?? { nav: 10000, cash_balance: 10000 };
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
  const isCron = verifyCronSecret(req);
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
    // Phase 4: prefer the US pool; fall back to any row pre-057 (no market column)
    let { data: portfolio } = await svc.from("paper_portfolio").select("nav, cash_balance").eq("market", "us").limit(1).maybeSingle();
    if (!portfolio) ({ data: portfolio } = await svc.from("paper_portfolio").select("nav, cash_balance").limit(1).maybeSingle());
    portfolio = portfolio ?? { nav: 10000, cash_balance: 10000 };
    const nav = Number(portfolio.nav ?? 10000);
    const cashBalance = Number(portfolio.cash_balance ?? 10000);

    // Count open positions (US pool only — this snapshot is the $ book)
    let posCount = await svc.from("paper_positions").select("*", { count: "exact", head: true }).eq("market", "us");
    if (posCount.error) posCount = await svc.from("paper_positions").select("*", { count: "exact", head: true });
    const openPositions = posCount.count ?? 0;

    // Sum realized pnl from closed trades (US only)
    let closedRes = await svc.from("paper_trades").select("realized_pnl").not("outcome", "is", null).eq("market", "us");
    if (closedRes.error) closedRes = await svc.from("paper_trades").select("realized_pnl").not("outcome", "is", null);
    const closedRows = closedRes.data;
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
