import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getQuote } from "@/lib/data/quotes";
import { fetchIndiaQuote } from "@/lib/india-data";
import { classifyOutcome } from "@/lib/trade-outcome";

export const dynamic = "force-dynamic";

// Manual close — human-initiated only, never cron-callable. PositionMonitor
// still closes automatically on stop/target/score-decay; this is the
// override for "I want out now" (a real gap flagged 2026-07-06 — there was
// no manual close path in the UI before this).
export async function POST(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const symbol = String(body.symbol ?? "").toUpperCase();
  const market: "us" | "india" = body.market === "india" ? "india" : "us";
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const svc = createServiceClient();

  let posQ = svc.from("paper_positions").select("*").eq("symbol", symbol);
  const { data: hasMarketColProbe } = await svc.from("paper_positions").select("market").limit(1);
  const hasMarketCol = hasMarketColProbe !== null;
  if (hasMarketCol) posQ = posQ.eq("market", market);
  const { data: pos } = await posQ.maybeSingle();
  if (!pos) return NextResponse.json({ error: `No open ${market.toUpperCase()} position in ${symbol}` }, { status: 404 });

  let currentPrice: number | null = pos.current_price ? Number(pos.current_price) : null;
  if (market === "india") {
    const q = await fetchIndiaQuote(symbol);
    if (q && q.price > 0) currentPrice = q.price;
  } else {
    const q = await getQuote(symbol, svc).catch(() => null);
    if (q?.price) currentPrice = q.price;
  }
  if (!currentPrice) return NextResponse.json({ error: `No live price available for ${symbol} — can't close without a fill price` }, { status: 502 });

  const realizedPnl = (currentPrice - Number(pos.avg_cost)) * Number(pos.qty);
  const pnlPct = Number(pos.avg_cost) > 0 ? ((currentPrice - Number(pos.avg_cost)) / Number(pos.avg_cost)) * 100 : 0;
  const outcome = classifyOutcome(pnlPct);
  const cur = market === "india" ? "₹" : "$";

  let tq = svc.from("paper_trades").select("id, qty, fill_price").eq("symbol", symbol).is("closed_at", null);
  if (hasMarketCol) tq = tq.eq("market", market);
  const { data: openTrades } = await tq;

  // Cash credited below is based solely on pos.qty; if it doesn't match the
  // sum of what we're actually marking closed in paper_trades, cash/NAV would
  // silently drift from the ledger with no signal. Log loudly rather than
  // fail the close (the position still needs to go away either way).
  const openTradesQtySum = (openTrades ?? []).reduce((s: number, t: any) => s + Number(t.qty ?? 0), 0);
  if (Math.abs(openTradesQtySum - Number(pos.qty)) > 0.001) {
    console.error(`[paper-positions/close] qty mismatch for ${symbol}: paper_positions.qty=${pos.qty} vs sum(open paper_trades.qty)=${openTradesQtySum} — cash credited off pos.qty may not match what's actually being closed`);
  }

  for (const t of (openTrades ?? []) as any[]) {
    const tQty = Number(t.qty ?? 0);
    const tFill = Number(t.fill_price ?? pos.avg_cost);
    const tPnl = (currentPrice - tFill) * tQty;
    const tPnlPct = tFill > 0 ? ((currentPrice - tFill) / tFill) * 100 : 0;
    const tOutcome = classifyOutcome(tPnlPct);
    await svc.from("paper_trades").update({
      exit_price: currentPrice, realized_pnl: tPnl, pnl_pct: tPnlPct,
      outcome: tOutcome, closed_at: new Date().toISOString(),
    }).eq("id", t.id);
  }

  await svc.from("paper_positions").delete().eq("id", pos.id);

  let portQ = svc.from("paper_portfolio").select("id, cash_balance");
  if (hasMarketCol) portQ = portQ.eq("market", market);
  const { data: portfolio } = await portQ.limit(1).maybeSingle();
  if (portfolio) {
    await svc.from("paper_portfolio").update({
      cash_balance: Number(portfolio.cash_balance) + currentPrice * Number(pos.qty),
    }).eq("id", portfolio.id);
  }

  await svc.from("decision_journal").insert({
    entry_type: "paper_exit", symbol,
    summary: `Manual close (${market.toUpperCase()}): ${pos.qty} × ${symbol} @ ${cur}${currentPrice.toFixed(2)} (user-initiated), P&L ${cur}${realizedPnl.toFixed(2)} (${outcome})`,
    calculations: { market, qty: pos.qty, exit_price: currentPrice, avg_cost: pos.avg_cost, realized_pnl: realizedPnl, pnl_pct: pnlPct, exit_reason: "manual_close" },
    has_verified_facts: true, has_calculations: true, resolved: true, resolved_at: new Date().toISOString(),
  }).then(() => {}, () => {});

  return NextResponse.json({ success: true, symbol, market, closed_at_price: currentPrice, realized_pnl: realizedPnl, pnl_pct: pnlPct, outcome });
}
