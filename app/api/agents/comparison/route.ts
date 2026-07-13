import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// GET /api/agents/comparison
// Per-MARKET performance of the research→paper pipeline (US vs India).
//
// This replaced a stale "Claude vs DeepSeek" agent A/B: the app moved 100% to
// DeepSeek, so grouping by agent_label showed every signal as "Claude" and an
// always-empty "DeepSeek" column, and it summed ₹ India trades under a $ sign.
// Grouping by market is the meaningful comparison that actually has data, with
// each side in its own currency.
export async function GET() {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = createServiceClient();

    const [{ data: signalRows, error: sigErr }, { data: tradeRows, error: tradeErr }] = await Promise.all([
      supabase.from("agent_signals").select("market, analyst_score, symbol"),
      supabase.from("paper_trades").select("market, realized_pnl, outcome, symbol"),
    ]);
    if (sigErr) throw new Error(sigErr.message);
    if (tradeErr) throw new Error(tradeErr.message);

    // Classify a row's market: prefer the explicit column; fall back to the
    // symbol suffix (.NS/.BO = India) for legacy rows written before market existed.
    const marketOf = (r: any): "us" | "india" => {
      const m = String(r.market ?? "").toLowerCase();
      if (m === "india") return "india";
      if (m === "us") return "us";
      return /\.(NS|BO)$/i.test(String(r.symbol ?? "")) ? "india" : "us";
    };

    const MARKETS: Array<{ market: "us" | "india"; label: string; currency: "$" | "₹" }> = [
      { market: "us", label: "US Market", currency: "$" },
      { market: "india", label: "India Market", currency: "₹" },
    ];

    const stats = MARKETS.map(({ market, label, currency }) => {
      const sigs = (signalRows ?? []).filter((r: any) => marketOf(r) === market);
      const trades = (tradeRows ?? []).filter((r: any) => marketOf(r) === market);

      const closed = trades.filter((t: any) => t.outcome === "win" || t.outcome === "loss");
      const wins = closed.filter((t: any) => t.outcome === "win").length;
      const losses = closed.filter((t: any) => t.outcome === "loss").length;

      const scores = sigs.map((s: any) => s.analyst_score).filter(Boolean) as number[];
      const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

      const pnlTrades = trades.filter((t: any) => t.realized_pnl != null) as Array<{ symbol: string; realized_pnl: number }>;
      const totalPnl = pnlTrades.reduce((s, t) => s + Number(t.realized_pnl), 0);

      let bestTrade: { symbol: string; pnl: number } | null = null;
      let worstTrade: { symbol: string; pnl: number } | null = null;
      if (pnlTrades.length > 0) {
        const sorted = [...pnlTrades].sort((a, b) => Number(b.realized_pnl) - Number(a.realized_pnl));
        bestTrade = { symbol: sorted[0].symbol, pnl: Number(sorted[0].realized_pnl) };
        worstTrade = { symbol: sorted[sorted.length - 1].symbol, pnl: Number(sorted[sorted.length - 1].realized_pnl) };
      }

      return {
        market,
        label,
        currency,
        signalCount: sigs.length,
        tradeCount: trades.length,
        wins,
        losses,
        winRate: closed.length > 0 ? Math.round((wins / closed.length) * 100) : null,
        avgAnalystScore: avgScore != null ? Math.round(avgScore * 10) / 10 : null,
        totalRealizedPnl: Math.round(totalPnl * 100) / 100,
        bestTrade,
        worstTrade,
      };
    });

    return NextResponse.json({ stats });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
