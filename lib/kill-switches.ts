// §4 kill-switch checks from Agent Knowledge Doctrine v1
// Call checkKillSwitches() before any paper or live trade execution.
// Returns { safe: true } or { safe: false, reason, tripped }

import { DEFAULT_KILL_SWITCH_DIALS } from "@/lib/risk-profiles";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export interface KillSwitchResult {
  safe: boolean;
  reason?: string;
  tripped?: "daily_loss" | "accuracy" | "drawdown";
}

const START_NAV: Record<string, number> = { us: 10000, india: 1000000 };

// Phase 4: kill-switches are evaluated PER MARKET. The daily-loss/drawdown/
// accuracy inputs (paper_performance, paper_trades) MUST be scoped to one market
// — mixing a ₹ NAV series with a $ one, or counting India trade outcomes toward
// US accuracy, produces garbage trips. Callers pass the market being gated.
// A helper that scopes a query to `market` but degrades to unscoped pre-057.
async function scoped(q: any, market: string): Promise<any> {
  const r = await q.eq("market", market);
  if (r.error) return await q; // pre-057: no market column → unscoped (US-only world)
  return r;
}

export async function checkKillSwitches(supabase: any, market: string = "us"): Promise<KillSwitchResult> {
  const startNav = START_NAV[market] ?? 10000;
  const [
    { data: portfolio },
    { data: recentPerf },
    { data: closedTrades },
    { data: cfg },
  ] = await Promise.all([
    supabase.from("paper_portfolio").select("nav, updated_at").eq("market", market).limit(1).maybeSingle(),
    scoped(supabase.from("paper_performance").select("date, nav, market").order("date", { ascending: true }).limit(90), market),
    scoped(
      supabase.from("paper_trades")
        .select("outcome, executed_at, realized_pnl, market")
        .not("outcome", "is", null)
        .gte("executed_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
      market
    ),
    // Profile-scaled thresholds (Part A1) — resilient: absent columns/row → hardcoded defaults below.
    supabase.from("strategy_config").select("ks_daily_loss_pct, ks_drawdown_pct, ks_accuracy_pct").maybeSingle(),
  ]);

  const nav = portfolio?.nav ?? startNav;
  const rawDailyLoss = Number(cfg?.ks_daily_loss_pct);
  const rawDrawdown = Number(cfg?.ks_drawdown_pct);
  const rawAccuracy = Number(cfg?.ks_accuracy_pct);
  const dailyLossLimit = Number.isFinite(rawDailyLoss) && rawDailyLoss !== 0 ? rawDailyLoss : DEFAULT_KILL_SWITCH_DIALS.ks_daily_loss_pct;
  const drawdownLimit = Number.isFinite(rawDrawdown) && rawDrawdown !== 0 ? rawDrawdown : DEFAULT_KILL_SWITCH_DIALS.ks_drawdown_pct;
  const accuracyLimit = Number.isFinite(rawAccuracy) && rawAccuracy !== 0 ? rawAccuracy : DEFAULT_KILL_SWITCH_DIALS.ks_accuracy_pct;

  // --- Kill switch 1: single-day loss beyond profile threshold (default -5%) ---
  // Compares CURRENT live NAV (already fetched above) against yesterday's
  // persisted close — NOT today's own paper_performance row, which doesn't
  // exist yet on the first (and often only) run of the day since paper-trade
  // upserts it near the END of this same route. Using todayPerf here meant
  // the same-day circuit breaker could never actually fire same-day.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = recentPerf?.filter((p: any) => p.date < today).at(-1);
  if (yesterday) {
    const dailyLossPct = ((nav - yesterday.nav) / yesterday.nav) * 100;
    if (dailyLossPct < dailyLossLimit) {
      await disableTrading(supabase, market, `Daily loss ${dailyLossPct.toFixed(1)}% exceeds ${dailyLossLimit}% threshold`);
      return { safe: false, tripped: "daily_loss", reason: `Daily loss ${dailyLossPct.toFixed(1)}% > ${dailyLossLimit}%` };
    }
  }

  // --- Kill switch 2: 30-day accuracy below profile threshold (default 40%) ---
  if (closedTrades && closedTrades.length >= 5) {
    const wins = closedTrades.filter((t: any) => t.outcome === "win").length;
    const accuracy = (wins / closedTrades.length) * 100;
    if (accuracy < accuracyLimit) {
      await disableTrading(supabase, market, `30-day accuracy ${accuracy.toFixed(0)}% below ${accuracyLimit}% threshold`);
      return { safe: false, tripped: "accuracy", reason: `30d accuracy ${accuracy.toFixed(0)}% < ${accuracyLimit}% (${closedTrades.length} trades)` };
    }
  }

  // --- Kill switch 3: drawdown beyond profile threshold (default 20%) from peak ---
  if (recentPerf && recentPerf.length > 0) {
    const navHistory = recentPerf.map((p: any) => p.nav as number);
    const peak = Math.max(...navHistory, startNav); // per-market starting NAV
    const drawdownPct = ((peak - nav) / peak) * 100;
    if (drawdownPct > drawdownLimit) {
      await disableTrading(supabase, market, `Drawdown ${drawdownPct.toFixed(1)}% exceeds ${drawdownLimit}% from peak $${peak.toFixed(0)}`);
      return { safe: false, tripped: "drawdown", reason: `Drawdown ${drawdownPct.toFixed(1)}% > ${drawdownLimit}% from peak` };
    }
  }

  // All clear this market — auto-resolve any open kill-switch alert. (Note: the
  // switch that auto-disabled trading is NOT auto-re-enabled here; a human
  // re-enables in Settings. This only clears the health alert once the metric
  // recovers, so a stale trip doesn't linger on the dashboard.)
  await resolveIssue(`killswitch:${market}`);
  return { safe: true };
}

async function disableTrading(supabase: any, market: string, reason: string) {
  console.error(`[kill-switch] TRADING DISABLED (${market}): ${reason}`);
  await supabase
    .from("strategy_config")
    .update({ trading_enabled: false, notes: `Auto-disabled: ${reason}` })
    .not("id", "is", null);
  await reportIssue({
    issueKey: `killswitch:${market}`,
    severity: "critical", category: "trading",
    title: `Kill switch tripped (${market.toUpperCase()}) — trading auto-disabled`,
    detail: `${reason}. Trading is halted for ${market.toUpperCase()} until you review and re-enable it in Settings → Trading.`,
  });

  // G8: quarantine resting/unresolved LIVE orders for this market so the owner can
  // review them. We do NOT auto-cancel — no deterministic broker cancel is wired and
  // no cron/LLM may cancel a live order. This only flags them for human action.
  try {
    const { data: flagged } = await supabase.from("broker_orders")
      .update({ risk_status: "kill_switch_review_required", risk_status_at: new Date().toISOString(), risk_status_reason: reason })
      .eq("market", market).eq("broker_env", "live")
      .in("status", ["pending_submit", "submitted", "partially_filled", "unknown_needs_reconcile"])
      .is("risk_status", null)
      .select("id");
    if (flagged && flagged.length > 0) {
      await reportIssue({
        issueKey: `killswitch-orders:${market}`,
        severity: "critical", category: "trading",
        title: `${flagged.length} open live ${market.toUpperCase()} order(s) need review (kill switch)`,
        detail: `The kill switch tripped while ${flagged.length} live order(s) were still open at the broker. They are flagged kill_switch_review_required — review and cancel them manually at the broker if needed. The app does not auto-cancel live orders.`,
      });
    }
  } catch { /* flagging is best-effort — must never block the kill switch itself */ }
}
