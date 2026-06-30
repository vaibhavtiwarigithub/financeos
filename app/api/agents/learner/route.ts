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
    const cronSecret = req.headers.get("x-cron-secret");
    const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;

    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createServiceClient();

    const { data: runRow } = await supabase.from("agent_runs").insert({
      agent_type: "learner", status: "running",
    } as any).select().single();
    const runId = (runRow as any)?.id ?? null;

    // ── Weekly LLM reassessment of held positions ──────────────────────────────
    // For positions older than 7 days where target hasn't been reassessed in 6+ days:
    // - Score < 40 or direction flipped short → flag exit_reason="llm_exit" (position-monitor closes it)
    // - Score >= 65 → raise price_target by 5% (extend winner)
    // Reads latest agent_signals only — does NOT spawn new research.
    const { data: openPositions } = await supabase
      .from("paper_positions")
      .select("*")
      .is("closed_at", null);

    const positionReassessments: string[] = [];

    if (openPositions && openPositions.length > 0) {
      for (const pos of openPositions) {
        // Only reassess positions at least 7 days old
        const ageMs = Date.now() - new Date(pos.created_at ?? pos.opened_at ?? 0).getTime();
        if (ageMs < 7 * 24 * 60 * 60 * 1000) continue;

        // Only reassess if target_updated_at is null or > 6 days ago
        const daysSinceTargetUpdate = pos.target_updated_at
          ? (Date.now() - new Date(pos.target_updated_at).getTime()) / 86400000
          : 999;
        if (daysSinceTargetUpdate < 6) continue;

        // Check for the latest signal for this symbol
        const { data: latestSignal } = await supabase
          .from("agent_signals")
          .select("analyst_score, price_target, direction")
          .eq("symbol", pos.symbol)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (!latestSignal) continue;

        if (latestSignal.analyst_score < 40 || latestSignal.direction === "short") {
          // Thesis broken — flag for position-monitor to close
          await supabase.from("paper_positions").update({
            exit_reason: "llm_exit",
            target_updated_at: new Date().toISOString(),
          }).eq("id", pos.id);
          positionReassessments.push(`${pos.symbol}: flagged llm_exit (score=${latestSignal.analyst_score}, direction=${latestSignal.direction})`);
        } else if (latestSignal.analyst_score >= 65 && pos.price_target) {
          // Conviction still high — raise target by 5%
          const newTarget = parseFloat((pos.price_target * 1.05).toFixed(2));
          await supabase.from("paper_positions").update({
            price_target: newTarget,
            target_updated_at: new Date().toISOString(),
          }).eq("id", pos.id);
          positionReassessments.push(`${pos.symbol}: target raised $${pos.price_target}→$${newTarget} (score=${latestSignal.analyst_score})`);
        } else {
          // No action, but record that we checked
          await supabase.from("paper_positions").update({
            target_updated_at: new Date().toISOString(),
          }).eq("id", pos.id);
        }
      }
    }
    // ── End reassessment ───────────────────────────────────────────────────────

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

      // Per-trade 1-sentence learning note
      const noteOutcome = outcome === "win" ? `+$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)` : `–$${Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(1)}%)`;
      await supabase.from("learning_log").insert({
        note: `${trade.symbol} ${outcome.toUpperCase()}: exited at $${exitPrice.toFixed(2)} vs entry $${trade.fill_price.toFixed(2)}, ${noteOutcome}. Held ${Math.round((Date.now() - new Date(trade.executed_at).getTime()) / 86400000)}d.`,
        weight_snapshot: null,
        trades_evaluated: 1,
      });

      outcomes.push({ symbol: trade.symbol, outcome, pnl, pnlPct, exitPrice, priceSource: quote.source });
    }

    const wins = outcomes.filter(o => o.outcome === "win").length;
    const losses = outcomes.filter(o => o.outcome === "loss").length;

    // Phase 0: weight mutation disabled.
    // Weight adjustment requires minimum 10 closed trades and champion/challenger
    // governance (FEATURE_ARCHITECTURE.md Phase 1). Logging outcomes only.
    await supabase.from("learning_log").insert({
      note: `Batch summary: Closed ${outcomes.length} paper trades: ${wins}W / ${losses}L. ${priceFailures.length} skipped (price unavailable: ${priceFailures.join(", ") || "none"}). Position reassessments: ${positionReassessments.length > 0 ? positionReassessments.join("; ") : "none"}. Weight mutation disabled in Phase 0.`,
      weight_snapshot: null,
      trades_evaluated: outcomes.length,
    });

    if (runId) {
      const closedSymbols = outcomes.map(o => o.symbol);
      await supabase.from("agent_runs").update({
        status: "done",
        symbols: closedSymbols,
        signals_written: outcomes.length,
        result_summary: `Closed ${outcomes.length} trades: ${wins}W/${losses}L. ${priceFailures.length} price failures.`,
        completed_at: new Date().toISOString(),
        tokens_input: 0,
        tokens_output: 0,
        claude_calls: 0,
      } as any).eq("id", runId);
    }

    return NextResponse.json({
      success: true,
      closed: outcomes.length,
      priceFailures: priceFailures.length,
      outcomes,
      positionReassessments,
      weightsAdjusted: false,
      note: "Weight mutation disabled in Phase 0 — requires champion/challenger governance",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
