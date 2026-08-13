// Thin protective-stop placement wrapper for Kite (India live).
//
// Kite GTT is "single-leg": SELL CNC LIMIT at stopPrice. Because the child is a
// LIMIT order (not market), it CAN fail to fill on a large gap-down — the limit
// order sits in the book at stopPrice and no one meets it at that level.
// This is weaker than Robinhood's GTC stop-market, but it's the best Kite offers.
//
// This module only places / cancels. State (triggerId) is stored in
// protective_orders.broker_order_id by the caller.

import { placeKiteStopGtt, cancelKiteGtt } from "@/lib/kite";

export async function placeKiteProtectiveStop(opts: {
  tradingsymbol: string; // NSE/BSE symbol, suffix stripped inside placeKiteStopGtt
  exchange?: string;     // defaults to NSE
  qty: number;
  lastPrice: number;     // pre-order reference quote
  stopPrice: number;     // trigger + limit price
}): Promise<{ ok: true; brokerOrderId: string } | { ok: false; error: string }> {
  const r = await placeKiteStopGtt(opts);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, brokerOrderId: String(r.triggerId) };
}

export async function cancelKiteProtectiveStop(
  brokerOrderId: string
): Promise<{ ok: boolean; error?: string }> {
  const triggerId = Number(brokerOrderId);
  if (!Number.isFinite(triggerId)) return { ok: false, error: `invalid Kite triggerId: ${brokerOrderId}` };
  return cancelKiteGtt(triggerId);
}
