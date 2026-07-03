// Kill-switch checks — Deno-compatible port of lib/kill-switches.ts

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
    supabase.from("paper_trades").select("outcome, executed_at, realized_pnl")
      .not("outcome", "is", null)
      .gte("executed_at", new Date(Date.now() - 30 * 86400000).toISOString()),
  ]);

  const nav = portfolio?.nav ?? 10000;
  const today = new Date().toISOString().slice(0, 10);
  const todayPerf = recentPerf?.find((p: any) => p.date === today);
  const yesterday = recentPerf?.filter((p: any) => p.date < today).at(-1);

  if (todayPerf && yesterday) {
    const dailyLoss = ((todayPerf.nav - yesterday.nav) / yesterday.nav) * 100;
    if (dailyLoss < -5) {
      await supabase.from("strategy_config").update({ trading_enabled: false }).not("id", "is", null);
      return { safe: false, tripped: "daily_loss", reason: `Daily loss ${dailyLoss.toFixed(1)}% > -5%` };
    }
  }

  if (closedTrades && closedTrades.length >= 5) {
    const wins = closedTrades.filter((t: any) => t.outcome === "win").length;
    const acc = (wins / closedTrades.length) * 100;
    if (acc < 40) {
      await supabase.from("strategy_config").update({ trading_enabled: false }).not("id", "is", null);
      return { safe: false, tripped: "accuracy", reason: `30d accuracy ${acc.toFixed(0)}% < 40%` };
    }
  }

  if (recentPerf && recentPerf.length > 0) {
    const peak = Math.max(...recentPerf.map((p: any) => p.nav as number), 10000);
    const drawdown = ((peak - nav) / peak) * 100;
    if (drawdown > 20) {
      await supabase.from("strategy_config").update({ trading_enabled: false }).not("id", "is", null);
      return { safe: false, tripped: "drawdown", reason: `Drawdown ${drawdown.toFixed(1)}% > 20%` };
    }
  }

  return { safe: true };
}
