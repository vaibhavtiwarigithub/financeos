import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { getQuote, computeExitFillPrice } from "@/lib/data/quotes";
import { fetchIndiaQuote } from "@/lib/india-data";

export const dynamic = "force-dynamic";

// Manual paper close — owner-only. Use the same atomic lot/cash ledger as the
// PositionMonitor; never update trades, positions, and cash independently.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const market = body.market;
  const requestedReason = body.exit_reason ?? "manual_close";
  const allowedReasons = new Set(["manual_close", "manual_owner_consolidation_to_8"]);
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }
  if (typeof requestedReason !== "string" || !allowedReasons.has(requestedReason)) {
    return NextResponse.json({ error: "unsupported paper exit reason" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: pos, error: positionError } = await svc
    .from("paper_positions")
    .select("id,symbol,market,qty,avg_cost,position_role")
    .eq("symbol", symbol)
    .eq("market", market)
    .maybeSingle();
  if (positionError) {
    return NextResponse.json({ error: `Could not identify a unique open position: ${positionError.message}` }, { status: 409 });
  }
  if (!pos) return NextResponse.json({ error: `No open ${market.toUpperCase()} position in ${symbol}` }, { status: 404 });
  if (pos.position_role === "hedge") {
    return NextResponse.json({ error: "Close a hedge through its hedge-control workflow so its controller state is reconciled." }, { status: 409 });
  }

  let observedPrice: number | null = null;
  let stale = true;
  let bid: number | null = null;
  let source = "unavailable";
  let observedAt: string | null = null;
  if (market === "india") {
    const quote = await fetchIndiaQuote(symbol);
    if (quote) {
      observedPrice = quote.price;
      stale = quote.stale;
      source = "yahoo";
      observedAt = quote.retrievedAt;
    }
  } else {
    const quote = await getQuote(symbol, svc).catch(() => null);
    if (quote) {
      observedPrice = quote.price;
      stale = quote.stale;
      bid = quote.bid;
      source = quote.source;
      observedAt = quote.observedAt ?? quote.retrievedAt;
    }
  }
  if (!observedPrice || !Number.isFinite(observedPrice) || observedPrice <= 0 || stale) {
    return NextResponse.json({
      error: `No fresh executable paper mark for ${symbol}; position was not changed.`,
      quote: { source, observed_at: observedAt, stale },
    }, { status: 502 });
  }

  const exitPrice = computeExitFillPrice(observedPrice, bid);
  const consolidation = requestedReason === "manual_owner_consolidation_to_8";
  const { data, error } = await svc.rpc("execute_paper_manual_exit", {
    p_position_id: pos.id,
    p_exit_price: exitPrice,
    p_exit_reason: requestedReason,
  });
  if (error) return NextResponse.json({ error: `Atomic paper exit failed: ${error.message}` }, { status: 500 });
  const result = data as any;
  if (!result?.ok) {
    return NextResponse.json({ error: `Paper exit refused: ${result?.error ?? "unknown"}` }, { status: 409 });
  }

  return NextResponse.json({
    success: true,
    symbol,
    market,
    exit_price: exitPrice,
    observed_price: observedPrice,
    quote_source: source,
    quote_observed_at: observedAt,
    realized_pnl: Number(result.realized_pnl ?? 0),
    closed_qty: Number(result.closed_qty ?? pos.qty),
    remaining_qty: Number(result.remaining_qty ?? 0),
    exit_reason: requestedReason,
    excluded_from_learning: consolidation,
  });
}
