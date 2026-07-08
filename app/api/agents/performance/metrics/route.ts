import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import {
  navToReturns, sharpe, sortino, maxDrawdown, expectancy, costNet, calibration,
  slip, MODELED_SLIP_PCT,
} from "@/lib/analytics/performance-metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Build 3 — performance-truth metrics, per market. READ-ONLY, owner-gated.
//
// Truth stance: this endpoint reports on EVERY closed trade, including
// data-provider-tainted ones. That is deliberate and the opposite of the Build 5
// learner filter — the learner must not LEARN from tainted trades, but the P&L
// dashboard must not HIDE them (they still moved the book). Tainted count is
// surfaced as its own field so the reader can judge the mix.
export async function GET() {
  try {
    const gate = await requireOwner();
    if (gate) return gate;
    const svc = createServiceClient();

    const markets = ["us", "india"] as const;
    const out: Record<string, unknown> = {};

    for (const market of markets) {
      // Daily NAV series (per market) — Sharpe/Sortino/drawdown source.
      const { data: perfRows } = await svc
        .from("paper_performance")
        .select("date, nav, spy_return_pct, alpha_pct")
        .eq("market", market)
        .order("date", { ascending: true })
        .limit(400);
      const nav = (perfRows ?? [])
        .map((r: any) => Number(r.nav))
        .filter((x: number) => Number.isFinite(x));
      const returns = navToReturns(nav);

      // Closed trades (per market) — expectancy / profit factor / cost / calibration.
      const { data: tradeRows } = await svc
        .from("paper_trades")
        .select("pnl_pct, outcome, analyst_score, spread_applied, fill_price, tainted, realized_slip_pct")
        .eq("market", market)
        .not("closed_at", "is", null);
      const trades = tradeRows ?? [];
      const closedN = trades.length;
      const taintedN = trades.filter((t: any) => t.tainted === true).length;

      const exp = expectancy(trades as any);
      const cost = costNet(trades as any);
      const realizedSlip = slip(trades as any);
      const calib = calibration(
        (trades as any[])
          .filter((t) => t.analyst_score != null && t.outcome != null)
          .map((t) => ({
            predicted: Number(t.analyst_score) / 100,
            win: t.outcome === "win",
          }))
      );

      // Benchmark: latest cumulative alpha vs SPY from the perf series.
      const last = (perfRows ?? [])[perfRows!.length - 1] as any | undefined;

      out[market] = {
        closedTrades: closedN,
        taintedTrades: taintedN,
        navPoints: nav.length,
        sharpe: sharpe(returns),
        sortino: sortino(returns),
        maxDrawdown: maxDrawdown(nav),
        expectancyPct: { value: exp.value, n: exp.n, insufficient: exp.insufficient },
        winRate: exp.winRate,
        avgWinPct: exp.avgWin,
        avgLossPct: exp.avgLoss,
        profitFactor: exp.profitFactor,
        cost,
        slip: { realized: realizedSlip, modeledPct: MODELED_SLIP_PCT },
        calibration: calib,
        alphaPct: last?.alpha_pct != null ? Number(last.alpha_pct) : null,
        benchmarkReturnPct: last?.spy_return_pct != null ? Number(last.spy_return_pct) : null,
      };
    }

    return NextResponse.json({ ok: true, markets: out, generatedAt: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "metrics_failed" }, { status: 500 });
  }
}
