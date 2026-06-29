import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchQuote, fetchQuotes } from "@/lib/market-data";

// PaperTrader: fills virtual long-only trades from qualifying signals.
// Prices come from Robinhood MCP via fetchQuote — never from LLM estimation.
// Long-only enforcement: only processes direction="long" signals.
export async function POST(req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // All DB ops use service client — bypasses RLS on agent/paper tables
    const supabase = createServiceClient();

    const { data: runRow } = await supabase.from("agent_runs").insert({
      agent_type: "paper_trader", status: "running",
    } as any).select().single();
    const runId = (runRow as any)?.id ?? null;

    // Get paper portfolio
    const { data: portfolioArr } = await supabase.from("paper_portfolio").select("*").limit(1);
    let portfolio = portfolioArr?.[0];
    if (!portfolio) {
      const { data: newP } = await supabase
        .from("paper_portfolio")
        .insert({ cash_balance: 10000, nav: 10000 })
        .select()
        .single();
      portfolio = newP;
    }
    if (!portfolio) {
      return NextResponse.json({ error: "No paper portfolio found" }, { status: 500 });
    }

    // Only qualifying LONG signals not yet paper-traded
    const { data: signals } = await supabase
      .from("agent_signals")
      .select("*")
      .eq("status", "pending")
      .eq("direction", "long") // long-only enforcement
      .gte("analyst_score", 60)
      .order("analyst_score", { ascending: false })
      .limit(5);

    if (!signals || signals.length === 0) {
      if (runId) await supabase.from("agent_runs").update({ status: "done", signals_written: 0, result_summary: "No qualifying long signals (score ≥ 60, direction = long)", completed_at: new Date().toISOString() } as any).eq("id", runId);
      return NextResponse.json({ skipped: true, reason: "No qualifying long signals (score ≥ 60, direction = long)" });
    }

    const filled: any[] = [];
    const skipped: any[] = [];

    for (const signal of signals) {
      // Idempotent claim: atomically set status→'claiming' only if still 'pending'
      // Prevents duplicate fills if this route is called concurrently
      const { data: claimed } = await supabase
        .from("agent_signals")
        .update({ status: "claiming" })
        .eq("id", signal.id)
        .eq("status", "pending")
        .select("id");
      if (!claimed || claimed.length === 0) continue; // already claimed

      // Fetch real price from Robinhood MCP — skip if unavailable
      const quote = await fetchQuote(signal.symbol);

      if (quote.source === "unavailable" || quote.price <= 0) {
        // Release claim so it can be retried later
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: "price_unavailable" });
        continue;
      }

      const fillPrice = quote.price;

      // Size: max 10% of current NAV, whole shares only
      const maxSpend = portfolio.cash_balance * 0.10;
      const qty = Math.floor(maxSpend / fillPrice);
      if (qty < 1) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: "insufficient_cash_for_1_share" });
        continue;
      }

      const totalCost = qty * fillPrice;
      if (totalCost > portfolio.cash_balance) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: "insufficient_cash" });
        continue;
      }

      // Record paper trade — always "buy" (long-only)
      await supabase.from("paper_trades").insert({
        symbol: signal.symbol,
        order_side: "buy",
        qty,
        fill_price: fillPrice,
        signal_id: signal.id,
        analyst_score: signal.analyst_score,
        direction: "long",
        rationale: `${signal.rationale ?? ""} [price_source: ${quote.source}, fetched_at: ${quote.fetchedAt}]`,
        fundamental_score: null,
        technical_score: null,
        sentiment_score: null,
        macro_score: null,
      });

      // Update or create paper position
      const { data: existing } = await supabase
        .from("paper_positions")
        .select("*")
        .eq("symbol", signal.symbol)
        .single();

      if (existing) {
        const newQty = existing.qty + qty;
        const newAvg = ((existing.qty * existing.avg_cost) + totalCost) / newQty;
        await supabase
          .from("paper_positions")
          .update({ qty: newQty, avg_cost: newAvg, current_price: fillPrice })
          .eq("id", existing.id);
      } else {
        await supabase
          .from("paper_positions")
          .insert({ symbol: signal.symbol, qty, avg_cost: fillPrice, current_price: fillPrice });
      }

      // Deduct from cash
      portfolio.cash_balance -= totalCost;
      await supabase
        .from("paper_portfolio")
        .update({
          cash_balance: portfolio.cash_balance,
          total_invested: (portfolio.total_invested ?? 0) + totalCost,
        })
        .eq("id", portfolio.id);

      // Mark signal as paper-traded
      await supabase.from("agent_signals").update({ status: "paper_traded" }).eq("id", signal.id);

      filled.push({ symbol: signal.symbol, qty, fillPrice, totalCost, priceSource: quote.source });
    }

    // Refresh prices for all open positions before NAV snapshot
    const { data: positions } = await supabase.from("paper_positions").select("*");
    const openPositions: any[] = positions ?? [];

    if (openPositions.length > 0) {
      const { fetchQuotes } = await import("@/lib/market-data");
      const symbols: string[] = [...new Set(openPositions.map((p: any) => p.symbol as string))];
      const quotes = await fetchQuotes(symbols);
      for (const pos of openPositions) {
        const q = quotes[pos.symbol];
        if (q?.price > 0) {
          await supabase.from("paper_positions").update({ current_price: q.price }).eq("id", pos.id);
          pos.current_price = q.price; // update local ref for NAV calc below
        }
      }
    }

    const positionsValue = openPositions.reduce(
      (s: number, p: any) => s + p.qty * (p.current_price ?? p.avg_cost),
      0
    );
    const nav = portfolio.cash_balance + positionsValue;
    const today = new Date().toISOString().split("T")[0];

    await supabase.from("paper_performance").upsert(
      {
        date: today,
        nav,
        cash_balance: portfolio.cash_balance,
        positions_value: positionsValue,
        total_pnl: nav - 10000,
        total_pnl_pct: ((nav - 10000) / 10000) * 100,
      },
      { onConflict: "date" }
    );

    await supabase.from("paper_portfolio").update({ nav }).eq("id", portfolio.id);

    if (runId) {
      const tradedSymbols = filled.map((f: any) => f.symbol);
      await supabase.from("agent_runs").update({
        status: "done",
        symbols: tradedSymbols,
        signals_written: filled.length,
        result_summary: `${filled.length} trades filled, ${skipped.length} skipped. NAV: $${nav.toFixed(2)}`,
        completed_at: new Date().toISOString(),
      } as any).eq("id", runId);
    }

    return NextResponse.json({ success: true, filled: filled.length, skipped: skipped.length, trades: filled, nav });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
