import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { placeEquityOrder, getKiteHoldings, placeKiteGtt, cancelKiteGtt } from "@/lib/kite";
import { requireOwner } from "@/lib/auth/require-owner";
import { guardOrderRequest } from "@/lib/request-guards";
import { fetchIndiaQuote } from "@/lib/india-data";
import { checkKillSwitches } from "@/lib/kill-switches";
import { reportIssue } from "@/lib/system-health";
import { checkLivePortfolioLimits } from "@/lib/risk/live-portfolio-gate";
import { liveOrdersAllowed } from "@/lib/autonomy";

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
  const { symbol, transaction_type, quantity, order_type, price, confirm, signal_id, manualOverride, overrideReason, client_order_key } = body as {
    symbol?: string; transaction_type?: "BUY" | "SELL"; quantity?: number;
    order_type?: "MARKET" | "LIMIT"; price?: number; confirm?: boolean;
    signal_id?: string; manualOverride?: boolean; overrideReason?: string; client_order_key?: string;
  };

  if (confirm !== true) {
    return NextResponse.json({ error: "confirm:true required — this places a real order with real money." }, { status: 400 });
  }
  // Idempotency: the UI must send a stable key per confirmation so a double-click / retry
  // dedupes at the DB (a partial unique index) instead of double-submitting a live order.
  if (!client_order_key || typeof client_order_key !== "string" || client_order_key.length < 8) {
    return NextResponse.json({ error: "client_order_key required (a stable per-confirmation id for idempotency)." }, { status: 400 });
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

  // Global + per-market trading gate + kill switches — same standard as the US
  // Execution Gateway. This standalone Kite path previously skipped these, so a
  // tripped kill switch or a disabled India toggle did NOT stop a live India order.
  {
    const { data: gate } = await svc.from("strategy_config").select("trading_enabled, trading_enabled_india, autonomy_level").limit(1).maybeSingle();
    // Autonomy ladder (migration 124) — master gate above trading_enabled. Live
    // requires L3_live_manual+; L4/L5 autonomous are not honored (owner click
    // stays mandatory via requireOwner). See lib/autonomy.ts.
    if (!liveOrdersAllowed((gate as any)?.autonomy_level)) {
      return NextResponse.json({ error: `Live orders blocked by autonomy level '${(gate as any)?.autonomy_level ?? "unset"}' — live requires L3_live_manual or higher (raise it in Settings → Agents).` }, { status: 403 });
    }
    if (!(gate as any)?.trading_enabled) {
      return NextResponse.json({ error: "Live trading is disabled (strategy_config.trading_enabled = false)" }, { status: 403 });
    }
    if ((gate as any)?.trading_enabled_india === false) {
      return NextResponse.json({ error: "Live trading is disabled for INDIA (view-only mode — re-enable in Settings → Agents)" }, { status: 403 });
    }
    // Side-aware: a trip blocks a BUY (new exposure) but not a risk-reducing
    // SELL (held-qty is verified separately below on the live path).
    const ks = await checkKillSwitches(svc, { market: "india", book: "live" });
    const ksBlocks = transaction_type === "SELL" ? !ks.sellAllowed : !ks.safe;
    if (ksBlocks) return NextResponse.json({ error: `Kill switch active: ${ks.reason}` }, { status: 403 });
  }

  // Per-order INR notional cap + daily caps (read together). FAIL CLOSED on the
  // per-order cap: no trusted Kite equity fallback exists, so a null India cap
  // refuses the order. Notional is checked against a fresh LTP (and the limit price
  // when higher), refusing if neither is available.
  const { data: capCfg } = await svc.from("strategy_config").select("max_order_notional_inr, max_daily_notional_inr, max_daily_trades, stop_loss_pct, target_pct").limit(1).maybeSingle();
  const inrCap = (capCfg as any)?.max_order_notional_inr;
  const perOrderCap = inrCap != null ? Number(inrCap) : null;
  // Per-order cap applies to BUY only — SELL exits (held-position gated below) must never
  // be blocked by a notional ceiling.
  if (transaction_type === "BUY" && (perOrderCap == null || !Number.isFinite(perOrderCap) || perOrderCap <= 0)) {
    return NextResponse.json({ error: "No India (INR) per-order cap set — refusing an uncapped live India order. Set the India cap in Settings → Live Order Limits." }, { status: 403 });
  }
  const q = await fetchIndiaQuote(symbol).catch(() => null);
  const ltp = Number(q?.price) || 0;
  const limitRef = order_type === "LIMIT" ? Number(price) || 0 : 0;
  const refPrice = Math.max(ltp, limitRef);
  if (!Number.isFinite(refPrice) || refPrice <= 0) {
    return NextResponse.json({ error: "Could not fetch a fresh India quote to validate the order notional — refusing to submit blind." }, { status: 502 });
  }
  const orderNotional = (quantity as number) * refPrice;
  if (transaction_type === "BUY" && perOrderCap != null && orderNotional > perOrderCap) {
    return NextResponse.json({ error: `Order notional ₹${orderNotional.toFixed(0)} exceeds the India cap ₹${perOrderCap.toFixed(0)}` }, { status: 403 });
  }
  const dailyTradesCap = (capCfg as any)?.max_daily_trades ?? null;
  const dailyNotionalCap = (capCfg as any)?.max_daily_notional_inr ?? null;

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

  // G1 parity for India: a live BUY must be governed like the US Gateway — either linked
  // to a signal with acceptable data quality, or an explicit, AUDITED manual override.
  // SELL exits are exempt.
  if (transaction_type === "BUY") {
    let qualityOk = false;
    if (signal_id) {
      const { data: dq } = await svc.from("v_decision_quality").select("data_confidence, quality_status").eq("signal_id", signal_id).order("ts", { ascending: false }).limit(1).maybeSingle();
      const conf = dq ? Number((dq as any).data_confidence) : null;
      qualityOk = !!dq && (dq as any).quality_status === "ok" && Number.isFinite(conf as number) && (conf as number) >= 0.5;
    }
    if (!qualityOk) {
      if (!manualOverride) {
        return NextResponse.json({ error: signal_id
          ? `Refusing India live BUY of ${symbol}: linked signal data confidence below the 0.5 threshold. Send manualOverride:true + overrideReason to proceed.`
          : `Refusing India live BUY of ${symbol}: no linked signal to verify data quality. Send manualOverride:true + overrideReason for a manual buy.` }, { status: 409 });
      }
      if (!overrideReason || !String(overrideReason).trim()) {
        return NextResponse.json({ error: "manualOverride:true requires a non-empty overrideReason (audited)." }, { status: 400 });
      }
      // Persist the override BEFORE any budget reservation / broker submit.
      // FAIL CLOSED: if the audit insert errors, abort — never let an
      // un-auditable override reach the broker.
      const { error: mAuditErr } = await svc.from("decision_journal").insert({
        entry_type: "manual_override", symbol, market: "india",
        summary: `Manual India BUY override: ${quantity} ${symbol} — ${String(overrideReason).slice(0, 300)}`,
        calculations: { transaction_type, quantity, signal_id: signal_id ?? null, override: true },
        has_verified_facts: false, resolved: false,
      });
      if (mAuditErr) {
        return NextResponse.json({ error: `Manual override could not be audited (${mAuditErr.message}) — aborting live order (fail-closed).` }, { status: 500 });
      }
    }
  }

  // G3: live portfolio-construction gate — India parity with the US Execution Gateway.
  // BUY only; SELL reduces exposure and is exempt.
  if (transaction_type === "BUY") {
    const pg = await checkLivePortfolioLimits({
      supabase: svc, market: "india", accountId: "kite",
      symbol: symbol.toUpperCase(), orderNotional,
    });
    if (!pg.ok) {
      if (!manualOverride) {
        return NextResponse.json({
          error: `Portfolio limit would be breached: ${pg.reason}${pg.adjustments?.length ? " — " + pg.adjustments.join("; ") : ""}. Send manualOverride:true + overrideReason to proceed.`,
          adjustments: pg.adjustments,
        }, { status: 409 });
      }
      if (!overrideReason || !String(overrideReason).trim()) {
        return NextResponse.json({ error: "manualOverride:true requires a non-empty overrideReason (audited)." }, { status: 400 });
      }
      // FAIL CLOSED: audit the portfolio-limit override before it bypasses G3.
      const { error: pAuditErr } = await svc.from("decision_journal").insert({
        entry_type: "portfolio_limit_override", symbol, market: "india",
        summary: `India G3 portfolio limit override: ${pg.reason} — ${String(overrideReason).slice(0, 300)}`,
        calculations: { transaction_type, quantity, signal_id: signal_id ?? null, portfolioGate: pg },
        has_verified_facts: false, resolved: false,
      });
      if (pAuditErr) {
        return NextResponse.json({ error: `Portfolio-limit override could not be audited (${pAuditErr.message}) — aborting live order (fail-closed).` }, { status: 500 });
      }
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

  // Atomic daily-budget reservation + durable pending row (G4/G5/G6). Under a
  // per-(day,market) advisory lock this serializes concurrent live India orders,
  // enforces the daily trade COUNT + cumulative INR NOTIONAL (BUY only — SELL exits
  // exempt), and inserts the pending broker_orders row the sync cron reconciles.
  const { data: reservedId, error: insertErr } = await svc.rpc("reserve_live_order_budget", {
    p_proposal_id: null, p_market: "india", p_broker: "kite", p_broker_env: "live",
    p_symbol: symbol.toUpperCase(), p_side: transaction_type === "BUY" ? "buy" : "sell",
    p_qty: quantity, p_order_type: order_type ?? "MARKET",
    p_limit_price: order_type === "LIMIT" ? price : null,
    p_estimated_notional: orderNotional, p_currency: "INR",
    p_max_daily_trades: dailyTradesCap, p_max_daily_notional: dailyNotionalCap,
    p_client_order_key: client_order_key,
  });
  if (insertErr) {
    const m = insertErr.message || "";
    if (m.includes("daily_trade_limit")) return NextResponse.json({ error: `Daily live-order limit reached — ${m}` }, { status: 429 });
    if (m.includes("daily_notional_limit")) return NextResponse.json({ error: `Daily notional cap reached — ${m}` }, { status: 403 });
    if ((insertErr as any).code === "23505" || m.toLowerCase().includes("duplicate")) return NextResponse.json({ error: "Duplicate order (same confirmation key already active) — not resubmitted." }, { status: 409 });
    return NextResponse.json({ error: `Failed to reserve order budget: ${m}` }, { status: 500 });
  }
  const ledgerId: number = reservedId as unknown as number;

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
  // Durable broker acknowledgment (P0-3): when Kite CONFIRMED the order, this ACK
  // is the source of truth and MUST persist. Bounded DB-only retry — never
  // resubmit to Kite. If a CONFIRMED order's ACK still fails to persist, we cannot
  // report success: emit a CRITICAL alert carrying the known Kite order_id and
  // return 202 needs_reconcile so it is recovered, never silently lost.
  const confirmedOrderId = res.ok && res.data?.order_id ? String(res.data.order_id) : null;
  let kiteAckErr: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await svc.from("broker_orders").update({
      status: outcomeStatus,
      broker_order_id: confirmedOrderId,
      error: res.ok ? (needsReconcile ? "Kite reported success with no order_id — needs manual reconciliation" : null) : res.error,
    }).eq("id", ledgerId);
    if (!error) { kiteAckErr = null; break; }
    kiteAckErr = error;
  }
  if (kiteAckErr && res.ok && !needsReconcile) {
    await reportIssue({
      issueKey: `kite-order-ack-persist-failed:${ledgerId}`,
      severity: "critical", category: "trading",
      title: `Kite order #${ledgerId} placed but ACK not persisted`,
      detail: `Kite CONFIRMED a live order (order_id ${confirmedOrderId}, ${transaction_type} ${quantity} ${symbol}) but broker_orders #${ledgerId} could not be updated after 3 attempts: ${kiteAckErr.message ?? kiteAckErr}. The order is LIVE at Kite. Reconcile broker_orders #${ledgerId} → order_id ${confirmedOrderId} before any resubmit.`,
    }, svc);
    return NextResponse.json({
      success: false, needsReconcile: true, broker_order_id: ledgerId, kite_order_id: confirmedOrderId,
      error: `Order placed at Kite (order_id ${confirmedOrderId}) but acknowledgment could not be persisted — needs reconcile, do NOT resubmit`,
    }, { status: 202 });
  }

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

  // Server-side stop/target via Kite GTT (BUY only, best-effort — a GTT failure does
  // NOT reverse the already-confirmed order, it's logged and the BUY still reports success).
  if (transaction_type === "BUY") {
    const stopPct = Number((capCfg as any)?.stop_loss_pct);
    const targetPct = Number((capCfg as any)?.target_pct);
    if (Number.isFinite(stopPct) && stopPct > 0 && Number.isFinite(targetPct) && targetPct > 0) {
      const stopPrice = refPrice * (1 - stopPct / 100);
      const targetPrice = refPrice * (1 + targetPct / 100);
      const gttResult = await placeKiteGtt({ tradingsymbol: symbol, qty: quantity as number, lastPrice: refPrice, stopPrice, targetPrice }, svc)
        .catch(() => ({ ok: false, error: "exception" } as const));
      if (gttResult.ok && gttResult.triggerId) {
        await svc.from("broker_orders").update({ kite_gtt_id: String(gttResult.triggerId) }).eq("id", ledgerId).catch(() => {});
      }
      await svc.from("decision_journal").insert({
        entry_type: "kite_gtt", symbol, market: "india",
        summary: gttResult.ok
          ? `GTT placed (trigger ${gttResult.triggerId}): stop ₹${stopPrice.toFixed(2)}, target ₹${targetPrice.toFixed(2)}`
          : `GTT placement failed (best-effort, BUY already confirmed): ${gttResult.error}`,
        calculations: { stop_pct: stopPct, target_pct: targetPct, ref_price: refPrice, broker_order_ledger_id: ledgerId },
        has_verified_facts: true, resolved: gttResult.ok,
      }).catch(() => {});
    }
  }

  // On SELL success: cancel the most recent resting GTT for this symbol (best-effort).
  if (transaction_type === "SELL") {
    const { data: resting } = await svc.from("broker_orders")
      .select("id, kite_gtt_id").eq("market", "india").eq("symbol", symbol.toUpperCase())
      .eq("side", "buy").not("kite_gtt_id", "is", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (resting?.kite_gtt_id) {
      await cancelKiteGtt(Number(resting.kite_gtt_id), svc).catch(() => {});
      await svc.from("broker_orders").update({ kite_gtt_id: null }).eq("id", resting.id).catch(() => {});
    }
  }

  return NextResponse.json({ success: true, order_id: res.data?.order_id, broker_order_id: ledgerId });
}
