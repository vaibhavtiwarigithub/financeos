import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchQuote } from "@/lib/market-data";

// LearnerAgent: closes paper positions older than 7 days and records outcomes.
// Phase 0 safety: weight mutation is DISABLED.
// Weight adjustment requires champion/challenger governance (Phase 1).
// Prices come from Robinhood MCP via fetchQuote — never from LLM estimation.
export async function POST(req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = createServiceClient();

    // Get open paper trades older than 7 market days
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: openTrades } = await supabase
      .from("paper_trades")
      .select("*")
      .is("closed_at", null)
      .lt("executed_at", cutoff);

    if (!openTrades || openTrades.length === 0) {
      return NextResponse.json({ skipped: true, reason: "No trades ready to close (< 7 days old)" });
    }

    const outcomes: any[] = [];
    const priceFailures: string[] = [];

    for (const trade of openTrades) {
      // Fetch exit price from Robinhood MCP — skip if unavailable
      const quote = await fetchQuote(trade.symbol);

      if (quote.source === "unavailable" || quote.price <= 0) {
        priceFailures.push(trade.symbol);
        continue;
      }

      const exitPrice = quote.price;

      // Calculate P&L — long-only: all trades are buys
      const pnl = (exitPrice - trade.fill_price) * trade.qty;
      const pnlPct = ((exitPrice - trade.fill_price) / trade.fill_price) * 100;
      const outcome = pnl > 0.5 ? "win" : pnl < -0.5 ? "loss" : "breakeven";

      // Close the trade
      await supabase.from("paper_trades").update({
        exit_price: exitPrice,
        realized_pnl: pnl,
        pnl_pct: pnlPct,
        outcome,
        closed_at: new Date().toISOString(),
        rationale: `${trade.rationale ?? ""} [exit_price_source: ${quote.source}, exit_fetched_at: ${quote.fetchedAt}]`,
      }).eq("id", trade.id);

      // Return proceeds to cash
      const { data: portfolioArr } = await supabase.from("paper_portfolio").select("*").limit(1);
      const portfolio = portfolioArr?.[0];
      if (portfolio) {
        const proceeds = exitPrice * trade.qty;
        await supabase
          .from("paper_portfolio")
          .update({ cash_balance: portfolio.cash_balance + proceeds })
          .eq("id", portfolio.id);
      }

      // Reduce position qty — remove if fully closed
      const { data: pos } = await supabase
        .from("paper_positions")
        .select("*")
        .eq("symbol", trade.symbol)
        .single();

      if (pos) {
        const remainingQty = pos.qty - trade.qty;
        if (remainingQty <= 0) {
          await supabase.from("paper_positions").delete().eq("id", pos.id);
        } else {
          await supabase.from("paper_positions").update({ qty: remainingQty }).eq("id", pos.id);
        }
      }

      outcomes.push({ symbol: trade.symbol, outcome, pnl, pnlPct, exitPrice, priceSource: quote.source });
    }

    const wins = outcomes.filter(o => o.outcome === "win").length;
    const losses = outcomes.filter(o => o.outcome === "loss").length;

    // Phase 0: weight mutation disabled.
    // Weight adjustment requires minimum 10 closed trades and champion/challenger
    // governance (FEATURE_ARCHITECTURE.md Phase 1). Logging outcomes only.
    await supabase.from("learning_log").insert({
      note: `Closed ${outcomes.length} paper trades: ${wins}W / ${losses}L. ${priceFailures.length} skipped (price unavailable: ${priceFailures.join(", ") || "none"}). Weight mutation disabled in Phase 0.`,
      weight_snapshot: null,
      trades_evaluated: outcomes.length,
    });

    return NextResponse.json({
      success: true,
      closed: outcomes.length,
      priceFailures: priceFailures.length,
      outcomes,
      weightsAdjusted: false,
      note: "Weight mutation disabled in Phase 0 — requires champion/challenger governance",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
