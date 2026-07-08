import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { placeEquityOrder, getKiteHoldings } from "@/lib/kite";
import { requireOwner } from "@/lib/auth/require-owner";
import { guardOrderRequest } from "@/lib/request-guards";
import { fetchIndiaQuote } from "@/lib/india-data";

export const dynamic = "force-dynamic";

// Places a REAL Zerodha order. Safety model, deliberately human-in-the-loop:
//  - Owner-only (requireOwner) — same standard as the US Execution Gateway.
//  - CSRF/origin guard (guardOrderRequest) — prevents cross-site live order.
//  - Requires explicit confirm:true in the body — a bare call won't fire.
//  - Creates a broker_orders ledger row so the sync loop can track/reconcile.
//  - SELL gated against current Kite holdings (long-only for new positions).
export async function POST(req: NextRequest) {
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;
  const guardErr = guardOrderRequest(req);
  if (guardErr) return guardErr;

  const body = await req.json().catch(() => ({}));
  const { symbol, transaction_type, quantity, order_type, price, confirm } = body as {
    symbol?: string; transaction_type?: "BUY" | "SELL"; quantity?: number;
    order_type?: "MARKET" | "LIMIT"; price?: number; confirm?: boolean;
  };

  if (confirm !== true) {
    return NextResponse.json({ error: "confirm:true required — this places a real order with real money." }, { status: 400 });
  }

  // Strict input validation — never clamp or silently coerce on a live-money path.
  if (!symbol || typeof symbol !== "string" || !/^[A-Z0-9._-]{1,20}$/.test(symbol.toUpperCase())) {
    return NextResponse.json({ error: "symbol required and must be a valid ticker" }, { status: 400 });
  }
  if (transaction_type !== "BUY" && transaction_type !== "SELL") {
    return NextResponse.json({ error: "transaction_type must be BUY or SELL" }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || (quantity as number) < 1) {
    return NextResponse.json({ error: "quantity must be a positive integer" }, { status: 400 });
  }
  if ((order_type ?? "MARKET") === "LIMIT" && (!Number.isFinite(price) || (price as number) <= 0)) {
    return NextResponse.json({ error: "price required for a LIMIT order" }, { status: 400 });
  }

  const svc = createServiceClient();

  // Per-order INR notional cap — FAIL CLOSED. Mirrors the Execution Gateway's
  // per-market cap on this standalone Kite path. No trusted Kite equity fallback
  // exists, so a null India cap refuses the order. Notional is checked against a
  // fresh LTP (and the limit price when higher), refusing if neither is available.
  {
    const { data: capCfg } = await svc.from("strategy_config").select("max_order_notional_inr").limit(1).maybeSingle();
    const inrCap = (capCfg as any)?.max_order_notional_inr;
    const cap = inrCap != null ? Number(inrCap) : null;
    if (cap == null || !Number.isFinite(cap) || cap <= 0) {
      return NextResponse.json({ error: "No India (INR) per-order cap set — refusing an uncapped live India order. Set the India cap in Settings → Live Order Limits." }, { status: 403 });
    }
    const q = await fetchIndiaQuote(symbol).catch(() => null);
    const ltp = Number(q?.price) || 0;
    const limitRef = order_type === "LIMIT" ? Number(price) || 0 : 0;
    const refPrice = Math.max(ltp, limitRef);
    if (!Number.isFinite(refPrice) || refPrice <= 0) {
      return NextResponse.json({ error: "Could not fetch a fresh India quote to validate the order notional — refusing to submit blind." }, { status: 502 });
    }
    const notional = (quantity as number) * refPrice;
    if (notional > cap) {
      return NextResponse.json({ error: `Order notional ₹${notional.toFixed(0)} exceeds the India cap ₹${cap.toFixed(0)}` }, { status: 403 });
    }
  }

  // Long-only gate: SELL requires confirmed current holding >= requested qty.
  if (transaction_type === "SELL") {
    const holdings = await getKiteHoldings(svc);
    if (!holdings.ok) {
      return NextResponse.json({ error: `Refusing SELL of ${symbol}: could not verify Kite holdings (${holdings.error ?? "connection failed"})` }, { status: 403 });
    }
    const sym = symbol.toUpperCase().replace(/\.(NS|BO)$/i, "");
    const pos = (holdings.data ?? []).find((h: any) => {
      const ts = String(h.tradingsymbol ?? "").toUpperCase();
      return ts === sym || ts === symbol.toUpperCase();
    });
    const heldQty = Number(pos?.quantity ?? pos?.qty ?? 0);
    if (heldQty < (quantity as number)) {
      return NextResponse.json({ error: `Refusing SELL of ${quantity} ${symbol}: only ${heldQty} held on Kite` }, { status: 403 });
    }
  }

  // Rate limit — bound live orders per rolling 10-minute window (stolen-cookie
  // burst protection), shared across US + India via the broker_orders ledger.
  const ORDER_RATE_LIMIT = Number(process.env.ORDER_RATE_LIMIT_10MIN ?? 12);
  const { count: recentOrders } = await svc
    .from("broker_orders")
    .select("id", { count: "exact", head: true })
    .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  if ((recentOrders ?? 0) >= ORDER_RATE_LIMIT) {
    return NextResponse.json({ error: `Order rate limit reached (${recentOrders}/${ORDER_RATE_LIMIT} in the last 10 min). Try again shortly.` }, { status: 429 });
  }

  // Pre-insert a broker_orders row before broker submission — creates a durable
  // order id ledger entry so the sync cron can track and reconcile this order.
  const { data: orderRow, error: insertErr } = await svc.from("broker_orders").insert({
    market: "india",
    broker: "kite",
    broker_env: "live",
    symbol: symbol.toUpperCase(),
    side: transaction_type === "BUY" ? "buy" : "sell",
    qty: quantity,
    order_type: order_type ?? "MARKET",
    limit_price: order_type === "LIMIT" ? price : null,
    status: "pending_submit",
    approved_by_user: true,
    submitted_at: new Date().toISOString(),
  }).select("id").single();

  if (insertErr) {
    return NextResponse.json({ error: `Failed to create order ledger entry: ${insertErr.message}` }, { status: 500 });
  }
  const ledgerId: number = (orderRow as any).id;

  const res = await placeEquityOrder({
    tradingsymbol: symbol,
    transaction_type,
    quantity: quantity as number,
    order_type: order_type ?? "MARKET",
    price,
    product: "CNC",
  });

  // Kite's success response should always include an order_id — if the call
  // reports success but the id is missing, the order state is ambiguous (may
  // or may not have gone through), not a confirmed success.
  const needsReconcile = res.ok && !res.data?.order_id;
  const outcomeStatus = !res.ok ? "failed" : needsReconcile ? "unknown_needs_reconcile" : "submitted";

  // Update the ledger row with the outcome (submitted, failed, or ambiguous).
  await svc.from("broker_orders").update({
    status: outcomeStatus,
    broker_order_id: res.ok && res.data?.order_id ? String(res.data.order_id) : null,
    error: res.ok ? (needsReconcile ? "Kite reported success with no order_id — needs manual reconciliation" : null) : res.error,
  }).eq("id", ledgerId);

  // Audit trail in decision_journal (best-effort, non-fatal).
  try {
    await svc.from("decision_journal").insert({
      entry_type: "kite_order",
      symbol, market: "india",
      summary: `Kite ${transaction_type} ${quantity} ${symbol} (${order_type ?? "MARKET"}${price ? ` @ ₹${price}` : ""}) → ${needsReconcile ? "AMBIGUOUS: no order_id returned, needs reconciliation" : res.ok ? `order ${res.data?.order_id}` : `FAILED: ${res.error}`}`,
      calculations: { transaction_type, quantity, order_type: order_type ?? "MARKET", price: price ?? null, order_id: res.data?.order_id ?? null, broker_order_ledger_id: ledgerId },
      has_verified_facts: true,
      resolved: res.ok && !needsReconcile,
    });
  } catch { /* audit is best-effort */ }

  if (!res.ok) return NextResponse.json({ success: false, error: res.error }, { status: 502 });
  if (needsReconcile) {
    return NextResponse.json({ success: false, needsReconcile: true, broker_order_id: ledgerId, error: "Order submitted but no order_id returned — check Kite manually before retrying" }, { status: 202 });
  }
  return NextResponse.json({ success: true, order_id: res.data?.order_id, broker_order_id: ledgerId });
}
