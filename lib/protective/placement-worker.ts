// Hybrid protective-stop PLACEMENT WORKER.
//
// Called after a confirmed live BUY fill to:
//   (a) place a GTC stop-market at Robinhood (US), OR
//   (b) place a single-leg GTT stop-limit at Kite (India),
// then record the broker id in protective_orders.
//
// GATED BEHIND TWO FLAGS — nothing executes unless BOTH are true:
//   1) PROTECTIVE_PLACEMENT_WORKER_AVAILABLE (code-level; false until toggled)
//   2) protective_orders_enabled (DB flag in strategy_config; false by default)
//
// This module also exports cancelProtectiveStop(), used by the live-exit-monitor
// before submitting a SELL to cancel the resting broker stop (avoid double-sell).

import { PROTECTIVE_PLACEMENT_WORKER_AVAILABLE } from "@/lib/protective/coverage";
import { managedLivePositionId } from "@/lib/protective/coverage";
import { evaluateProtection, ProtectionRequest } from "@/lib/protective/capabilities";
import { ROBINHOOD_PROTECTIVE_CAPABILITIES } from "@/lib/protective/robinhood-capabilities";
import { KITE_PROTECTIVE_CAPABILITIES } from "@/lib/protective/kite-capabilities";
import { placeRobinhoodGtcStop, cancelRobinhoodOrder } from "@/lib/robinhood-mcp";
import { placeKiteProtectiveStop, cancelKiteProtectiveStop } from "@/lib/protective/kite-placement";
import { loadTradingMandateStrict } from "@/lib/trading-mandate";

// ── Result types ──────────────────────────────────────────────────────────────

export type PlacementResult =
  | { ok: true;  protectiveOrderId: number; brokerOrderId: string; stopPrice: number }
  | { ok: false; skipped?: boolean; reason: string };

export type CancelResult =
  | { ok: true  }
  | { ok: false; reason: string };

// ── Place ─────────────────────────────────────────────────────────────────────

export interface PlaceProtectiveStopInput {
  supabase: any;
  symbol: string;
  market: "us" | "india";
  broker: string;                 // "robinhood_mcp" | "kite"
  brokerAccountId: string;
  qty: number;
  entryPrice: number;             // the BUY fill price (or best available quote)
  proposalId?: number | null;
  proposalBrokerOrderId?: string; // the BUY broker order id — used for correlation
}

export async function placeProtectiveStop(input: PlaceProtectiveStopInput): Promise<PlacementResult> {
  const { supabase, symbol, market, broker, brokerAccountId, qty, entryPrice, proposalId } = input;

  // Gate 1 — code-level flag (stays false until Part E).
  if (!PROTECTIVE_PLACEMENT_WORKER_AVAILABLE) {
    return { ok: false, skipped: true, reason: "PROTECTIVE_PLACEMENT_WORKER_AVAILABLE=false (feature not yet enabled)" };
  }

  // Gate 2 — DB flag.
  const { data: cfg } = await supabase.from("strategy_config")
    .select("protective_orders_enabled").limit(1).maybeSingle();
  if (cfg?.protective_orders_enabled !== true) {
    return { ok: false, skipped: true, reason: "protective_orders_enabled=false in strategy_config" };
  }

  // Derive stop price from mandate (stop_loss_pct).
  const mandate = await loadTradingMandateStrict(supabase, market);
  const stopPct = mandate.stop_loss_pct / 100;
  const stopPrice = parseFloat((entryPrice * (1 - stopPct)).toFixed(2));
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return { ok: false, reason: `invalid stop price derived from entry ${entryPrice} × (1-${mandate.stop_loss_pct}%)` };
  }

  // Evaluate broker eligibility (capability matrix).
  const caps = market === "india" ? KITE_PROTECTIVE_CAPABILITIES : ROBINHOOD_PROTECTIVE_CAPABILITIES;
  const req: ProtectionRequest = {
    market,
    instrumentType: "equity",
    accountMode: market === "india" ? "cnc" : "cash",
    side: "sell_long",
    minLifetimeDays: 1,
    session: "regular",
  };
  const elig = evaluateProtection(caps, req);
  if (!elig.protectedByBroker) {
    return { ok: false, reason: `broker ${broker} not eligible for protective stop: ${elig.reason}` };
  }

  // Stable position identifier (matches coverage.ts).
  const positionId = managedLivePositionId({ market, broker: caps.broker, brokerAccountId, symbol, qty });
  const correlationId = `prot:${positionId}:${Date.now()}`;

  // Insert row with status='placing' first (idempotent via correlation_id unique index).
  const insertPayload = {
    position_id:          positionId,
    proposal_id:          proposalId ?? null,
    broker:               caps.broker,
    broker_account_id:    brokerAccountId,
    market,
    symbol,
    currency:             market === "india" ? "INR" : "USD",
    mode:                 "wider_disaster_floor",
    order_kind:           elig.kind,
    analytical_stop:      stopPrice,
    broker_floor:         stopPrice,
    trigger_price:        stopPrice,
    limit_price:          elig.strength === "weaker_limit" ? stopPrice : null,
    protected_qty:        qty,
    reconciled_held_qty:  qty,
    status:               "placing",
    reason:               "post_buy_placement",
    correlation_id:       correlationId,
  };

  const { data: row, error: insertErr } = await supabase.from("protective_orders")
    .insert(insertPayload).select("id").single();
  if (insertErr) {
    // 23505 = duplicate correlation_id (retry scenario). Return safely.
    if (insertErr.code === "23505") {
      return { ok: false, reason: `duplicate protective placement for this position (correlation_id exists)` };
    }
    return { ok: false, reason: `protective_orders insert failed: ${insertErr.message}` };
  }
  const protectiveOrderId: number = (row as any).id;

  // Place at broker.
  let brokerResult: { ok: boolean; brokerOrderId?: string; error?: string };
  if (market === "us") {
    const r = await placeRobinhoodGtcStop({ account: brokerAccountId, symbol, qty, stopPrice });
    brokerResult = r.ok ? { ok: true, brokerOrderId: r.brokerOrderId } : { ok: false, error: r.error };
  } else {
    const r = await placeKiteProtectiveStop({ tradingsymbol: symbol, qty, lastPrice: entryPrice, stopPrice });
    brokerResult = r.ok ? { ok: true, brokerOrderId: r.brokerOrderId } : { ok: false, error: r.error };
  }

  if (!brokerResult.ok || !brokerResult.brokerOrderId) {
    // Mark failed — placement attempted but broker rejected or errored.
    await supabase.from("protective_orders").update({
      status: "failed",
      broker_version: brokerResult.error ?? "no broker order id",
    }).eq("id", protectiveOrderId);
    await supabase.from("protective_order_events").insert({
      protective_order_id: protectiveOrderId,
      event_type:          "failed",
      status_before:       "placing",
      status_after:        "failed",
      detail:              `Broker placement failed: ${brokerResult.error ?? "no broker order id"}`,
      broker_snapshot:     {},
    });
    return { ok: false, reason: `broker placement failed: ${brokerResult.error}` };
  }

  // Persist broker id and move to active.
  const brokerIdCol = market === "india" ? "kite_trigger_id" : "broker_order_id";
  await supabase.from("protective_orders").update({
    status:              "active",
    [brokerIdCol]:       brokerResult.brokerOrderId,
    last_reconciled_at:  new Date().toISOString(),
  }).eq("id", protectiveOrderId);
  await supabase.from("protective_order_events").insert({
    protective_order_id: protectiveOrderId,
    event_type:          "placed",
    status_before:       "placing",
    status_after:        "active",
    detail:              `${elig.kind} placed at ${caps.broker}: ${brokerResult.brokerOrderId} | stop=${stopPrice} qty=${qty}`,
    broker_snapshot:     { broker_order_id: brokerResult.brokerOrderId, stop_price: stopPrice },
  });

  return { ok: true, protectiveOrderId, brokerOrderId: brokerResult.brokerOrderId, stopPrice };
}

// ── Cancel ────────────────────────────────────────────────────────────────────

// Cancel any ACTIVE/PLACING protective stop for a position (called before an
// explicit SELL to avoid a double-sell after the broker stop also triggers).
export async function cancelProtectiveStop(input: {
  supabase: any;
  positionId: string;
  market: "us" | "india";
  brokerAccountId: string;
}): Promise<CancelResult> {
  const { supabase, positionId, market, brokerAccountId } = input;

  const { data: row, error } = await supabase.from("protective_orders")
    .select("id, broker_order_id, kite_trigger_id, status, broker, market")
    .eq("position_id", positionId)
    .in("status", ["placing", "active", "needs_reconcile"])
    .limit(1).maybeSingle();
  if (error) return { ok: false, reason: `protective_orders read failed: ${error.message}` };
  if (!row) return { ok: true };   // no active stop — nothing to cancel

  const brokerId = market === "india" ? (row as any).kite_trigger_id : (row as any).broker_order_id;
  if (!brokerId) {
    // Still in 'placing' — mark canceled; the placement will find no row to update.
    await supabase.from("protective_orders").update({ status: "canceled" }).eq("id", (row as any).id);
    return { ok: true };
  }

  // Mark as canceling first.
  await supabase.from("protective_orders").update({ status: "canceling" }).eq("id", (row as any).id);

  // Cancel at broker.
  let cancelOk: boolean;
  let cancelErr: string | undefined;
  if (market === "india") {
    const r = await cancelKiteProtectiveStop(brokerId);
    cancelOk = r.ok; cancelErr = r.error;
  } else {
    const r = await cancelRobinhoodOrder(brokerId, brokerAccountId);
    cancelOk = r.ok; cancelErr = (r as any).error;
  }

  if (!cancelOk) {
    // Mark needs_reconcile — can't confirm the cancel.
    await supabase.from("protective_orders").update({ status: "needs_reconcile" }).eq("id", (row as any).id);
    await supabase.from("protective_order_events").insert({
      protective_order_id: (row as any).id,
      event_type: "needs_reconcile",
      status_before: "canceling",
      status_after: "needs_reconcile",
      detail: `Cancel failed at broker: ${cancelErr ?? "unknown error"} — manual reconcile required`,
      broker_snapshot: {},
    });
    return { ok: false, reason: `broker cancel failed: ${cancelErr}` };
  }

  await supabase.from("protective_orders").update({ status: "canceled" }).eq("id", (row as any).id);
  await supabase.from("protective_order_events").insert({
    protective_order_id: (row as any).id,
    event_type: "canceled",
    status_before: "canceling",
    status_after: "canceled",
    detail: `Protective stop canceled at broker (${market === "india" ? "GTT" : "RH GTC"}: ${brokerId}) before explicit SELL`,
    broker_snapshot: { canceled_broker_order_id: brokerId },
  });
  return { ok: true };
}
