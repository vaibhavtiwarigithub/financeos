import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPaused, pausedResponse } from "../_shared/pause-check.ts";

const CRON_SECRET = "fos-cron-k9x2m7p4-2026";

serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.includes(CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { paused, reason } = await checkPaused(supabase);
  if (paused) return pausedResponse(reason);

  const polygonKey = Deno.env.get("MASSIVE_API_KEY") ?? Deno.env.get("POLYGON_API_KEY") ?? "";

  const { data: openTrades, error: tradesErr } = await supabase
    .from("paper_trades")
    .select("*")
    .is("outcome", null)
    .not("symbol", "is", null);

  if (tradesErr) {
    return new Response(JSON.stringify({ error: tradesErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  if (!openTrades || openTrades.length === 0) {
    return new Response(JSON.stringify({ ok: true, checked: 0, closed: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const symbols = [...new Set(openTrades.map((t: any) => t.symbol as string))];

  // Fetch prices via Polygon snapshot
  const prices: Record<string, number> = {};
  if (polygonKey) {
    const symbolList = symbols.join(",");
    try {
      const r = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(symbolList)}&apiKey=${polygonKey}`,
        { signal: AbortSignal.timeout(15000) }
      );
      const json = await r.json();
      for (const t of json?.tickers ?? []) {
        if (t?.ticker && t?.day?.c) prices[t.ticker] = t.day.c;
        else if (t?.ticker && t?.lastTrade?.p) prices[t.ticker] = t.lastTrade.p;
      }
    } catch { /* price fetch failed, fall through */ }
  }

  // Fallback: AV for any missing
  const avKey = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? "";
  for (const sym of symbols) {
    if (prices[sym]) continue;
    if (!avKey) continue;
    try {
      const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${sym}&apikey=${avKey}`, { signal: AbortSignal.timeout(10000) });
      const json = await r.json();
      const p = parseFloat(json?.["Global Quote"]?.["05. price"] ?? "0");
      if (p > 0) prices[sym] = p;
    } catch { /* skip */ }
  }

  let closed = 0;
  const closedDetails: any[] = [];

  for (const trade of openTrades) {
    const currentPrice = prices[trade.symbol];
    if (!currentPrice || currentPrice <= 0) continue;

    const entryPrice = Number(trade.entry_price ?? 0);
    const originalStop = Number(trade.stop_loss ?? entryPrice * 0.93);
    const highestPrice = Math.max(Number(trade.highest_price ?? entryPrice), currentPrice);
    const trailingStop = Math.max(originalStop, highestPrice * 0.93);

    // Update highest_price
    if (currentPrice > Number(trade.highest_price ?? 0)) {
      await supabase.from("paper_trades").update({ highest_price: currentPrice }).eq("id", trade.id);
    }

    // Check exit conditions
    const stopHit = currentPrice <= trailingStop;
    const targetHit = trade.take_profit && currentPrice >= Number(trade.take_profit);
    const llmExit = trade.llm_exit === true;

    if (!stopHit && !targetHit && !llmExit) continue;

    const exitReason = stopHit ? "trailing_stop" : targetHit ? "take_profit" : "llm_exit";
    const pnl = (currentPrice - entryPrice) * Number(trade.quantity ?? 1);
    const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
    const outcome = pnl >= 0 ? "win" : "loss";

    await supabase.from("paper_trades").update({
      exit_price: currentPrice,
      exit_reason: exitReason,
      exit_at: new Date().toISOString(),
      realized_pnl: parseFloat(pnl.toFixed(2)),
      realized_pnl_pct: parseFloat(pnlPct.toFixed(2)),
      outcome,
    }).eq("id", trade.id);

    // Append immutable event
    await supabase.from("paper_order_events").insert({
      trade_id: trade.id,
      symbol: trade.symbol,
      event_type: "exit",
      price: currentPrice,
      quantity: trade.quantity,
      reason: exitReason,
      created_at: new Date().toISOString(),
    });

    // Update NAV
    const { data: portfolio } = await supabase.from("paper_portfolio").select("nav").limit(1).single();
    if (portfolio) {
      await supabase.from("paper_portfolio").update({
        nav: parseFloat((Number(portfolio.nav) + pnl).toFixed(2)),
        updated_at: new Date().toISOString(),
      }).not("id", "is", null);
    }

    closed++;
    closedDetails.push({ symbol: trade.symbol, outcome, pnl: parseFloat(pnl.toFixed(2)), exitReason });
  }

  return new Response(JSON.stringify({ ok: true, checked: openTrades.length, closed, closedDetails }), {
    headers: { "Content-Type": "application/json" },
  });
});
