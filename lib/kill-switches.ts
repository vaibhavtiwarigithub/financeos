// §4 kill-switch checks from Agent Knowledge Doctrine v1
// Call checkKillSwitches() before any paper or live trade execution.
// Returns { safe: true } or { safe: false, reason, tripped }

export interface KillSwitchResult {
  safe: boolean;
  reason?: string;
  tripped?: "daily_loss" | "accuracy" | "drawdown";
}

export async function checkKillSwitches(supabase: any): Promise<KillSwitchResult> {
  const [
    { data: portfolio },
    { data: recentPerf },
    { data: closedTrades },
  ] = await Promise.all([
    supabase.from("paper_portfolio").select("nav, updated_at").limit(1).single(),
    supabase.from("paper_performance").select("date, nav").order("date", { ascending: true }).limit(90),
    supabase
      .from("paper_trades")
      .select("outcome, executed_at, realized_pnl")
      .not("outcome", "is", null)
      .gte("executed_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  const nav = portfolio?.nav ?? 10000;

  // --- Kill switch 1: single-day loss > 5% ---
  const today = new Date().toISOString().slice(0, 10);
  const todayPerf = recentPerf?.find((p: any) => p.date === today);
  const yesterday = recentPerf?.filter((p: any) => p.date < today).at(-1);
  if (todayPerf && yesterday) {
    const dailyLossPct = ((todayPerf.nav - yesterday.nav) / yesterday.nav) * 100;
    if (dailyLossPct < -5) {
      await disableTrading(supabase, `Daily loss ${dailyLossPct.toFixed(1)}% exceeds -5% threshold`);
      return { safe: false, tripped: "daily_loss", reason: `Daily loss ${dailyLossPct.toFixed(1)}% > -5%` };
    }
  }

  // --- Kill switch 2: 30-day accuracy < 40% ---
  if (closedTrades && closedTrades.length >= 5) {
    const wins = closedTrades.filter((t: any) => t.outcome === "win").length;
    const accuracy = (wins / closedTrades.length) * 100;
    if (accuracy < 40) {
      await disableTrading(supabase, `30-day accuracy ${accuracy.toFixed(0)}% below 40% threshold`);
      return { safe: false, tripped: "accuracy", reason: `30d accuracy ${accuracy.toFixed(0)}% < 40% (${closedTrades.length} trades)` };
    }
  }

  // --- Kill switch 3: drawdown > 20% from peak ---
  if (recentPerf && recentPerf.length > 0) {
    const navHistory = recentPerf.map((p: any) => p.nav as number);
    const peak = Math.max(...navHistory, 10000); // $10k = starting NAV
    const drawdownPct = ((peak - nav) / peak) * 100;
    if (drawdownPct > 20) {
      await disableTrading(supabase, `Drawdown ${drawdownPct.toFixed(1)}% exceeds 20% from peak $${peak.toFixed(0)}`);
      return { safe: false, tripped: "drawdown", reason: `Drawdown ${drawdownPct.toFixed(1)}% > 20% from peak` };
    }
  }

  return { safe: true };
}

async function disableTrading(supabase: any, reason: string) {
  console.error(`[kill-switch] TRADING DISABLED: ${reason}`);
  await supabase
    .from("strategy_config")
    .update({ trading_enabled: false, notes: `Auto-disabled: ${reason}` })
    .not("id", "is", null);
}
