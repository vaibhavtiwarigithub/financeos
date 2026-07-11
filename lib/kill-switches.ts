// §4 kill-switch checks from Agent Knowledge Doctrine v1
// Call checkKillSwitches() before any paper or live trade execution.
// Returns { safe: true } or { safe: false, reason, tripped }
// When live_auto_enabled=true, reads live_account_snapshots instead of paper tables.
// Fail-closed: if live mode active but no snapshots exist, blocks execution.

import { DEFAULT_KILL_SWITCH_DIALS } from "@/lib/risk-profiles";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export interface KillSwitchResult {
  safe: boolean;
  reason?: string;
  tripped?: "daily_loss" | "accuracy" | "drawdown";
}

const START_NAV: Record<string, number> = { us: 10000, india: 1000000 };

// Per-market scope helper for paper tables (pre-057 fallback: no market column → unscoped).
async function scoped(q: any, market: string): Promise<any> {
  const r = await q.eq("market", market);
  if (r.error) return await q;
  return r;
}

// ── Live data helpers ────────────────────────────────────────────────────────

type LiveNavSeries = { current: number; yesterday: number | null; peak90: number };

async function getLiveNavSeries(
  supabase: any,
  accountId: string,
  market: string,
): Promise<LiveNavSeries | null> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: snaps } = await supabase
    .from("live_account_snapshots")
    .select("equity, portfolio_value, captured_at")
    .eq("account_id", accountId)
    .gte("captured_at", since)
    .order("captured_at", { ascending: false });

  if (!snaps || snaps.length === 0) return null;

  const nav = (s: any): number =>
    Number(s.equity ?? s.portfolio_value ?? 0);
  const current = nav(snaps[0]);
  if (!Number.isFinite(current) || current <= 0) return null;

  const today = new Date().toISOString().slice(0, 10);
  const yesterdaySnap = (snaps as any[]).find(
    (s: any) => (s.captured_at as string) < today + "T00:00:00",
  );
  const yesterday = yesterdaySnap ? nav(yesterdaySnap) : null;

  const startNav = START_NAV[market] ?? current;
  const peak90 = Math.max(...(snaps as any[]).map(nav), startNav);

  return { current, yesterday, peak90 };
}

// Estimate live trade accuracy from broker_orders filled pairs.
// Approximation: most recent prior BUY avg_fill_price vs SELL avg_fill_price.
// Returns null when fewer than 5 countable pairs exist.
async function getLiveAccuracy(
  supabase: any,
  market: string,
): Promise<{ wins: number; total: number } | null> {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: sells } = await supabase
    .from("broker_orders")
    .select("symbol, avg_fill_price, created_at")
    .eq("market", market)
    .eq("broker_env", "live")
    .eq("side", "sell")
    .eq("status", "filled")
    .gte("created_at", since30);

  if (!sells || (sells as any[]).length < 5) return null;

  const symbols = [...new Set((sells as any[]).map((s: any) => s.symbol as string))];
  const since180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const { data: buys } = await supabase
    .from("broker_orders")
    .select("symbol, avg_fill_price, created_at")
    .eq("market", market)
    .eq("broker_env", "live")
    .eq("side", "buy")
    .eq("status", "filled")
    .in("symbol", symbols)
    .gte("created_at", since180);

  const buysBySymbol: Record<string, any[]> = {};
  for (const b of (buys ?? []) as any[]) {
    (buysBySymbol[b.symbol] ??= []).push(b);
  }

  let wins = 0;
  let counted = 0;
  for (const sell of (sells as any[])) {
    const prior = (buysBySymbol[sell.symbol] ?? [])
      .filter((b: any) => b.created_at < sell.created_at)
      .sort((a: any, b: any) =>
        (b.created_at as string).localeCompare(a.created_at),
      )[0];
    if (!prior) continue;
    counted++;
    if (Number(sell.avg_fill_price) > Number(prior.avg_fill_price)) wins++;
  }

  return counted >= 5 ? { wins, total: counted } : null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function checkKillSwitches(
  supabase: any,
  market: string = "us",
): Promise<KillSwitchResult> {
  const startNav = START_NAV[market] ?? 10000;

  const { data: cfg } = await supabase
    .from("strategy_config")
    .select(
      "ks_daily_loss_pct, ks_drawdown_pct, ks_accuracy_pct, live_auto_enabled, active_account_us, active_account_india",
    )
    .maybeSingle();

  const rawDailyLoss = Number(cfg?.ks_daily_loss_pct);
  const rawDrawdown = Number(cfg?.ks_drawdown_pct);
  const rawAccuracy = Number(cfg?.ks_accuracy_pct);
  const dailyLossLimit =
    Number.isFinite(rawDailyLoss) && rawDailyLoss !== 0
      ? rawDailyLoss
      : DEFAULT_KILL_SWITCH_DIALS.ks_daily_loss_pct;
  const drawdownLimit =
    Number.isFinite(rawDrawdown) && rawDrawdown !== 0
      ? rawDrawdown
      : DEFAULT_KILL_SWITCH_DIALS.ks_drawdown_pct;
  const accuracyLimit =
    Number.isFinite(rawAccuracy) && rawAccuracy !== 0
      ? rawAccuracy
      : DEFAULT_KILL_SWITCH_DIALS.ks_accuracy_pct;

  const isLive = Boolean(cfg?.live_auto_enabled);
  const activeAccount: string | null =
    market === "india"
      ? (cfg?.active_account_india ?? null)
      : (cfg?.active_account_us ?? null);

  // ── Collect metrics (live vs paper path) ──────────────────────────────────
  let nav: number;
  let yesterday: number | null = null;
  let peak: number | null = null;
  let accuracyData: { wins: number; total: number } | null = null;

  if (isLive && activeAccount) {
    // Live path: read from live_account_snapshots + broker_orders fills.
    // Fail-closed: if no snapshots available, do not allow execution — the
    // operator must run /api/broker/orders/sync at least once to seed data.
    const liveSeries = await getLiveNavSeries(supabase, activeAccount, market);
    if (!liveSeries) {
      return {
        safe: false,
        tripped: "drawdown",
        reason:
          "No live account snapshots found — kill switch fail-closed. Run broker sync (/api/broker/orders/sync) to seed live NAV data before enabling autonomous live trading.",
      };
    }
    nav = liveSeries.current;
    yesterday = liveSeries.yesterday;
    peak = liveSeries.peak90;
    accuracyData = await getLiveAccuracy(supabase, market);
  } else {
    // Paper path (original): paper_portfolio, paper_performance, paper_trades.
    const [{ data: portfolio }, { data: recentPerf }, { data: closedTrades }] =
      await Promise.all([
        supabase
          .from("paper_portfolio")
          .select("nav, updated_at")
          .eq("market", market)
          .limit(1)
          .maybeSingle(),
        scoped(
          supabase
            .from("paper_performance")
            .select("date, nav, market")
            .order("date", { ascending: true })
            .limit(90),
          market,
        ),
        scoped(
          supabase
            .from("paper_trades")
            .select("outcome, executed_at, realized_pnl, market")
            .not("outcome", "is", null)
            .gte(
              "executed_at",
              new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            ),
          market,
        ),
      ]);

    nav = portfolio?.nav ?? startNav;

    const today = new Date().toISOString().slice(0, 10);
    const perfArr: any[] = recentPerf ?? [];
    yesterday = perfArr.filter((p) => p.date < today).at(-1)?.nav ?? null;

    const navHistory = perfArr.map((p: any) => p.nav as number);
    peak =
      navHistory.length > 0 ? Math.max(...navHistory, startNav) : null;

    if (closedTrades && (closedTrades as any[]).length >= 5) {
      const wins = (closedTrades as any[]).filter(
        (t) => t.outcome === "win",
      ).length;
      accuracyData = { wins, total: (closedTrades as any[]).length };
    }
  }

  // ── Kill switch 1: single-day loss beyond threshold ───────────────────────
  if (yesterday !== null && Number.isFinite(yesterday) && yesterday > 0) {
    const dailyLossPct = ((nav - yesterday) / yesterday) * 100;
    if (dailyLossPct < dailyLossLimit) {
      await disableTrading(
        supabase,
        market,
        `Daily loss ${dailyLossPct.toFixed(1)}% exceeds ${dailyLossLimit}% threshold`,
      );
      return {
        safe: false,
        tripped: "daily_loss",
        reason: `Daily loss ${dailyLossPct.toFixed(1)}% > ${dailyLossLimit}%`,
      };
    }
  }

  // ── Kill switch 2: 30-day accuracy below threshold ────────────────────────
  if (accuracyData && accuracyData.total >= 5) {
    const accuracy = (accuracyData.wins / accuracyData.total) * 100;
    if (accuracy < accuracyLimit) {
      await disableTrading(
        supabase,
        market,
        `30-day accuracy ${accuracy.toFixed(0)}% below ${accuracyLimit}% threshold`,
      );
      return {
        safe: false,
        tripped: "accuracy",
        reason: `30d accuracy ${accuracy.toFixed(0)}% < ${accuracyLimit}% (${accuracyData.total} trades)`,
      };
    }
  }

  // ── Kill switch 3: drawdown from 90-day peak ──────────────────────────────
  if (peak !== null && peak > 0) {
    const drawdownPct = ((peak - nav) / peak) * 100;
    if (drawdownPct > drawdownLimit) {
      await disableTrading(
        supabase,
        market,
        `Drawdown ${drawdownPct.toFixed(1)}% exceeds ${drawdownLimit}% from peak $${peak.toFixed(0)}`,
      );
      return {
        safe: false,
        tripped: "drawdown",
        reason: `Drawdown ${drawdownPct.toFixed(1)}% > ${drawdownLimit}% from peak`,
      };
    }
  }

  // All clear — auto-resolve stale health alert (does NOT re-enable trading;
  // a human re-enables in Settings after reviewing the trip).
  await resolveIssue(`killswitch:${market}`);
  return { safe: true };
}

async function disableTrading(
  supabase: any,
  market: string,
  reason: string,
): Promise<void> {
  console.error(`[kill-switch] TRADING DISABLED (${market}): ${reason}`);
  await supabase
    .from("strategy_config")
    .update({ trading_enabled: false, notes: `Auto-disabled: ${reason}` })
    .not("id", "is", null);
  await reportIssue({
    issueKey: `killswitch:${market}`,
    severity: "critical",
    category: "trading",
    title: `Kill switch tripped (${market.toUpperCase()}) — trading auto-disabled`,
    detail: `${reason}. Trading is halted for ${market.toUpperCase()} until you review and re-enable it in Settings → Trading.`,
  });

  // G8: flag resting live orders for human review. No auto-cancel — no LLM
  // or cron may cancel a live order; the owner does it manually at the broker.
  try {
    const { data: flagged } = await supabase
      .from("broker_orders")
      .update({
        risk_status: "kill_switch_review_required",
        risk_status_at: new Date().toISOString(),
        risk_status_reason: reason,
      })
      .eq("market", market)
      .eq("broker_env", "live")
      .in("status", [
        "pending_submit",
        "submitted",
        "partially_filled",
        "unknown_needs_reconcile",
      ])
      .is("risk_status", null)
      .select("id");
    if (flagged && (flagged as any[]).length > 0) {
      await reportIssue({
        issueKey: `killswitch-orders:${market}`,
        severity: "critical",
        category: "trading",
        title: `${(flagged as any[]).length} open live ${market.toUpperCase()} order(s) need review (kill switch)`,
        detail: `The kill switch tripped while ${(flagged as any[]).length} live order(s) were still open. They are flagged kill_switch_review_required — cancel them manually at the broker if needed.`,
      });
    }
  } catch {
    /* flagging is best-effort — must never block the kill switch itself */
  }
}
