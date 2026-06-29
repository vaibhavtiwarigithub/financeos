import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// GET /api/agents/comparison
// Returns side-by-side stats for each agent_label in agent_signals / paper_trades.
export async function GET() {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = createServiceClient();

    // ── Signals grouped by agent_label ────────────────────────────────────────
    const { data: signalRows, error: sigErr } = await supabase
      .from("agent_signals")
      .select("agent_label, analyst_score, status");

    if (sigErr) throw new Error(sigErr.message);

    // ── Paper trades grouped by agent_label ───────────────────────────────────
    const { data: tradeRows, error: tradeErr } = await supabase
      .from("paper_trades")
      .select("agent_label, realized_pnl, outcome, analyst_score, symbol");

    if (tradeErr) throw new Error(tradeErr.message);

    // ── Build per-label stats ─────────────────────────────────────────────────
    type LabelStats = {
      label: string;
      signalCount: number;
      tradeCount: number;
      wins: number;
      losses: number;
      winRate: number | null;
      avgAnalystScore: number | null;
      totalRealizedPnl: number;
      bestTrade: { symbol: string; pnl: number } | null;
      worstTrade: { symbol: string; pnl: number } | null;
    };

    const labels = new Set<string>();
    for (const r of signalRows ?? []) labels.add(r.agent_label ?? "claude");
    for (const r of tradeRows ?? []) labels.add(r.agent_label ?? "claude");

    // Always show both columns even if deepseek has no data yet
    if (!labels.has("claude")) labels.add("claude");
    if (!labels.has("deepseek")) labels.add("deepseek");

    const stats: LabelStats[] = [];

    for (const label of Array.from(labels).sort()) {
      const sigs = (signalRows ?? []).filter((r: any) => (r.agent_label ?? "claude") === label);
      const trades = (tradeRows ?? []).filter((r: any) => (r.agent_label ?? "claude") === label);

      const closed = trades.filter((t: any) => t.outcome === "win" || t.outcome === "loss");
      const wins = closed.filter((t: any) => t.outcome === "win").length;
      const losses = closed.filter((t: any) => t.outcome === "loss").length;

      const scores = sigs.map((s: any) => s.analyst_score).filter(Boolean) as number[];
      const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

      const pnlTrades = trades.filter((t: any) => t.realized_pnl != null) as Array<{
        symbol: string;
        realized_pnl: number;
      }>;
      const totalPnl = pnlTrades.reduce((s, t) => s + t.realized_pnl, 0);

      let bestTrade: { symbol: string; pnl: number } | null = null;
      let worstTrade: { symbol: string; pnl: number } | null = null;
      if (pnlTrades.length > 0) {
        const sorted = [...pnlTrades].sort((a, b) => b.realized_pnl - a.realized_pnl);
        bestTrade = { symbol: sorted[0].symbol, pnl: sorted[0].realized_pnl };
        worstTrade = {
          symbol: sorted[sorted.length - 1].symbol,
          pnl: sorted[sorted.length - 1].realized_pnl,
        };
      }

      stats.push({
        label,
        signalCount: sigs.length,
        tradeCount: trades.length,
        wins,
        losses,
        winRate: closed.length > 0 ? Math.round((wins / closed.length) * 100) : null,
        avgAnalystScore: avgScore != null ? Math.round(avgScore * 10) / 10 : null,
        totalRealizedPnl: Math.round(totalPnl * 100) / 100,
        bestTrade,
        worstTrade,
      });
    }

    return NextResponse.json({ stats });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
