import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import type { Mkt } from "@/lib/format-money";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Paper starting NAV per market. The US $ book seeds at $10k, the India ₹ book at
// ₹10,00,000 (migration 057). Baselines are NEVER shared: a ₹ NAV measured against
// a 10000 baseline reads as +9,889% nonsense.
const SEED: Record<Mkt, number> = { us: 10_000, india: 1_000_000 };

// Per-market benchmark. US = SPY (from price_cache, the long-standing source for
// this panel); India = NIFTY 50, read from the bench_return_pct series that the
// paper-trade cron records into paper_performance (^NSEI is not in price_cache).
const BENCH_LABEL: Record<Mkt, string> = { us: "SPY", india: "NIFTY 50" };

export async function GET(req: NextRequest) {
  try {
    const svc = createServiceClient();

    // ?market=us|india — scope the whole panel to one book. Defaults to "us" so
    // existing callers (and the nav-snapshot cron) keep their US behaviour.
    // Every aggregate MUST be scoped or the other market's rows corrupt the win
    // rate / avg return / P&L / position count. Resilient: fall back to unscoped
    // pre-057 (US-only world).
    const market: Mkt = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
    const seed = SEED[market];

    // The unscoped retries below are the pre-057 fallback: back then there was a
    // single US-only book with no `market` column, so "everything" == "the US
    // rows". That equivalence does NOT hold for India — falling back to unscoped
    // there would label US $ rows as ₹. India fails closed to empty instead.
    const marketTrades = async () => {
      const cols = "id, symbol, realized_pnl, pnl_pct, outcome, executed_at, closed_at, analyst_score, order_side";
      const r = await svc.from("paper_trades").select(cols).eq("market", market).order("executed_at", { ascending: false });
      if (!r.error) return r.data ?? [];
      if (market !== "us") return [];
      const fb = await svc.from("paper_trades").select(cols).order("executed_at", { ascending: false });
      return fb.data ?? [];
    };
    const marketOpenCount = async () => {
      const r = await svc.from("paper_positions").select("*", { count: "exact", head: true }).eq("market", market);
      if (!r.error) return r.count ?? 0;
      if (market !== "us") return 0;
      const fb = await svc.from("paper_positions").select("*", { count: "exact", head: true });
      return fb.count ?? 0;
    };

    // 1. NAV history ordered asc for chart.
    //    US: paper_nav_history — has NO market column and is written only by the
    //    US nav-snapshot cron / the Snapshot NAV button, so it IS the $ series.
    //    India: that table would be a lie, so read the ₹ series from
    //    paper_performance, which is market-tagged and carries its own benchmark.
    let history: any[];
    let benchReturn = 0;
    if (market === "india") {
      const { data: perfRows } = await svc
        .from("paper_performance")
        .select("date, nav, cash_balance, bench_return_pct")
        .eq("market", "india")
        .order("date", { ascending: true });
      history = (perfRows ?? []).map((r: any) => ({
        date: r.date,
        nav: Number(r.nav),
        cash_balance: r.cash_balance != null ? Number(r.cash_balance) : null,
      }));
      // Cumulative NIFTY return as recorded against the first bench_nav of the
      // series. Null when the cron couldn't reach the quote — treat as 0/flat.
      const lastBench = [...(perfRows ?? [])].reverse().find((r: any) => r.bench_return_pct != null);
      benchReturn = lastBench ? Number(lastBench.bench_return_pct) : 0;
    } else {
      const { data: navHistory } = await svc
        .from("paper_nav_history")
        .select("date, nav, cash_balance, open_positions, realized_pnl")
        .order("date", { ascending: true });
      history = (navHistory ?? []) as any[];

      // SPY price_cache over the same date range as the nav history
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
          benchReturn = firstClose > 0 ? ((lastClose / firstClose) - 1) * 100 : 0;
        }
      }
    }

    // 2. Closed paper trades (this market only)
    const trades = (await marketTrades()) as any[];
    const closedTrades = trades.filter(
      (t: any) => t.outcome != null || t.closed_at != null
    );
    const closedCount = closedTrades.length;

    // 3. Open positions count (this market only)
    const openCount = await marketOpenCount();

    // 4. Current portfolio nav + cash — this market's pool.
    //    Phase 4: fall back to the sole row pre-057 (no market column) for US
    //    only; that row is the $ pool, so serving it as the ₹ pool would be a
    //    currency cross. India with no pool shows its ₹ seed instead.
    let { data: portfolio } = await svc.from("paper_portfolio").select("nav, cash_balance").eq("market", market).limit(1).maybeSingle();
    if (!portfolio && market === "us") ({ data: portfolio } = await svc.from("paper_portfolio").select("nav, cash_balance").limit(1).maybeSingle());
    portfolio = portfolio ?? { nav: seed, cash_balance: seed };
    const nav = Number(portfolio.nav ?? seed);
    const cash = Number(portfolio.cash_balance ?? seed);

    // 5. Computed metrics — all in this market's own currency, never crossed.
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
    const paperReturn = ((nav / seed) - 1) * 100;

    const gates = {
      minTrades: closedCount >= 10,
      winRate: winRate >= 55,
      positiveReturn: paperReturn > 0,
      beatsBench: paperReturn > benchReturn,
    };
    const allGatesPassed = Object.values(gates).every(Boolean);

    return NextResponse.json({
      market,
      seed,
      benchLabel: BENCH_LABEL[market],
      navHistory: history,
      trades: closedTrades,
      winRate,
      avgReturn,
      totalPnl,
      benchReturn,
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

// US ($) book ONLY, deliberately. This writes paper_nav_history, which has no
// `market` column — snapshotting the India ₹ pool here would silently overwrite
// the US $ series for the same date with a ₹ NAV. The India ₹ NAV series is
// recorded per-market into paper_performance by the paper-trade cron instead, so
// there is nothing to snapshot here for India and the UI hides the button.
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
