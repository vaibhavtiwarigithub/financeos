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
import { placeRobinhoodGtcStop, cancelRobinhoodOrder, queryRobinhoodOrder } from "@/lib/robinhood-mcp";
import { robinhoodCancelIsFinal, verifyRobinhoodRestingStop } from "@/lib/protective/robinhood-readback";
import { placeKiteProtectiveStop, cancelKiteProtectiveStop } from "@/lib/protective/kite-placement";
import { loadTradingMandateStrict } from "@/lib/trading-mandate";

// ── Result types ──────────────────────────────────────────────────────────────

export type PlacementResult =
  | { ok: true;  protectiveOrderId: number; brokerOrderId: string; stopPrice: number }
  | { ok: false; skipped?: boolean; needsReconcile?: boolean; reason: string };

export type CancelResult =
  | { ok: true; protectiveOrderId: number }
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
  stopPrice?: number;             // approved, symbol-specific analytical floor
}

export async function placeProtectiveStop(input: PlaceProtectiveStopInput): Promise<PlacementResult> {
  const { supabase, symbol, market, broker, brokerAccountId, qty, entryPrice, proposalId, proposalBrokerOrderId } = input;

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
  const stopPrice = input.stopPrice ?? parseFloat((entryPrice * (1 - stopPct)).toFixed(2));
  if (!Number.isFinite(stopPrice) || stopPrice <= 0 || stopPrice >= entryPrice) {
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
  const correlationId = `prot:${positionId}:${proposalBrokerOrderId ?? Date.now()}`;
  const { data: existingRows, error: existingErr } = await supabase.from("protective_orders")
    .select("id, status").eq("position_id", positionId)
    .in("status", ["placing", "active", "triggered", "canceling", "needs_reconcile"])
    .limit(2);
  if (existingErr) return { ok: false, needsReconcile: true, reason: `existing protective order lookup failed: ${existingErr.message}` };
  if ((existingRows ?? []).length > 0) {
    return { ok: false, needsReconcile: true, reason: "an unresolved protective order already exists for this position; refusing duplicate placement" };
  }

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
  let brokerResult: { ok: boolean; brokerOrderId?: string; needsReconcile?: boolean; error?: string };
  if (market === "us") {
    const r = await placeRobinhoodGtcStop({ account: brokerAccountId, symbol, qty, stopPrice });
    brokerResult = r.ok ? { ok: true, brokerOrderId: r.brokerOrderId } : { ok: false, needsReconcile: r.needsReconcile, error: r.error };
  } else {
    const r = await placeKiteProtectiveStop({ tradingsymbol: symbol, qty, lastPrice: entryPrice, stopPrice });
    brokerResult = r.ok ? { ok: true, brokerOrderId: r.brokerOrderId } : { ok: false, error: r.error };
  }

  if (!brokerResult.ok || !brokerResult.brokerOrderId) {
    // A timeout or unparseable acknowledgement may mean the broker accepted
    // the order. Never call this a rejection or send a second SELL blindly.
    const status = brokerResult.needsReconcile ? "needs_reconcile" : "failed";
    await supabase.from("protective_orders").update({
      status,
      broker_version: brokerResult.error ?? "no broker order id",
    }).eq("id", protectiveOrderId);
    await supabase.from("protective_order_events").insert({
      protective_order_id: protectiveOrderId,
      event_type:          status,
      status_before:       "placing",
      status_after:        status,
      detail:              `Broker placement failed: ${brokerResult.error ?? "no broker order id"}`,
      broker_snapshot:     {},
    });
    return { ok: false, needsReconcile: brokerResult.needsReconcile, reason: `broker placement ${status}: ${brokerResult.error}` };
  }

  if (market === "us") {
    const readback = await queryRobinhoodOrder(brokerResult.brokerOrderId, brokerAccountId);
    const verified = readback.ok && readback.status === "submitted"
      && verifyRobinhoodRestingStop(readback.raw, { symbol, account: brokerAccountId, qty, stopPrice });
    if (!verified) {
      await supabase.from("protective_orders").update({
        status: "needs_reconcile", broker_order_id: brokerResult.brokerOrderId,
      }).eq("id", protectiveOrderId);
      await supabase.from("protective_order_events").insert({
        protective_order_id: protectiveOrderId, event_type: "needs_reconcile",
        status_before: "placing", status_after: "needs_reconcile",
        detail: "Broker stop readback did not prove resting side/type/account/quantity/trigger/GTC",
        broker_snapshot: { broker_order_id: brokerResult.brokerOrderId, status: readback.status ?? "unreadable" },
      });
      return { ok: false, needsReconcile: true, reason: "broker stop exists or may exist but resting contract is unverified" };
    }
  }

  // Persist broker id and move to active.
  const brokerIdCol = market === "india" ? "kite_trigger_id" : "broker_order_id";
  const { error: activeErr } = await supabase.from("protective_orders").update({
    status:              "active",
    [brokerIdCol]:       brokerResult.brokerOrderId,
    last_reconciled_at:  new Date().toISOString(),
  }).eq("id", protectiveOrderId);
  if (activeErr) return { ok: false, needsReconcile: true, reason: `broker stop placed but ledger update failed: ${activeErr.message}` };
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

  const { data: rows, error } = await supabase.from("protective_orders")
    .select("id, broker_order_id, kite_trigger_id, status, broker, market")
    .eq("position_id", positionId)
    .in("status", ["placing", "active", "canceling", "needs_reconcile"])
    .limit(2);
  if (error) return { ok: false, reason: `protective_orders read failed: ${error.message}` };
  if ((rows ?? []).length !== 1) return { ok: false, reason: `expected one protective order, found ${(rows ?? []).length}; manual reconciliation required` };
  const row = rows[0];
  if (row.status === "canceling" || row.status === "needs_reconcile") {
    return { ok: false, reason: "protective state is unresolved; reconcile order and holdings before another exit" };
  }

  const brokerId = market === "india" ? (row as any).kite_trigger_id : (row as any).broker_order_id;
  if (!brokerId) {
    return { ok: false, reason: "protective placement has no broker id; cancellation cannot be proven" };
  }

  // Mark as canceling first.
  const { data: claimed, error: claimError } = await supabase.from("protective_orders")
    .update({ status: "canceling" }).eq("id", row.id).eq("status", row.status).select("id");
  if (claimError || claimed?.length !== 1) return { ok: false, reason: "protective cancellation ownership could not be acquired" };

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

  if (market === "us") {
    const readback = await queryRobinhoodOrder(brokerId, brokerAccountId);
    if (!readback.ok || !robinhoodCancelIsFinal(readback.status, readback.filledQty)) {
      await supabase.from("protective_orders").update({ status: "needs_reconcile" }).eq("id", (row as any).id);
      return { ok: false, reason: `cancel acknowledged but final unfilled cancellation unproven: ${readback.error ?? readback.status ?? "unreadable"}` };
    }
  }

  const { error: canceledErr } = await supabase.from("protective_orders").update({ status: "canceled" }).eq("id", (row as any).id);
  if (canceledErr) return { ok: false, reason: `broker canceled but ledger update failed: ${canceledErr.message}` };
  await supabase.from("protective_order_events").insert({
    protective_order_id: (row as any).id,
    event_type: "canceled",
    status_before: "canceling",
    status_after: "canceled",
    detail: `Protective stop canceled at broker (${market === "india" ? "GTT" : "RH GTC"}: ${brokerId}) before explicit SELL`,
    broker_snapshot: { canceled_broker_order_id: brokerId },
  });
  return { ok: true, protectiveOrderId: Number(row.id) };
}

/** An unsuccessful/unknown exit after stop cancellation is not protection.
 * Never replace blindly: a sell may have filled and replacement can oversell. */
export async function markProtectiveExitUnresolved(supabase: any, protectiveOrderId: number): Promise<void> {
  // Preserve the true terminal broker-stop status: canceled is not unknown.
  // The residual EXIT lifecycle needs reconciliation, not a resurrection of
  // the canceled order. Subsequent exit attempts fail the active-stop gate.
  const { error } = await supabase.from("protective_order_events").insert({
    protective_order_id: protectiveOrderId, event_type: "needs_reconcile",
    status_before: "canceled", status_after: "canceled",
    detail: "Protection canceled; explicit exit/remaining holdings require reconciliation before any retry or replacement",
    broker_snapshot: {},
  });
  if (error) throw new Error("Could not persist unprotected exit reconciliation state");
}
