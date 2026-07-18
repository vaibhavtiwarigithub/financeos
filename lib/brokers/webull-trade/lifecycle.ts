// ============================================================================
// webull_trade — order lifecycle (place / query / cancel / reconcile) over an
// injected transport. Deterministic, no LLM. Tested entirely against fixtures.
//
// Safety-critical rule (spec §"Order Lifecycle"): a timeout, a transport error
// after send, or a "success" response carrying NO parseable order id becomes
// `needsReconcile` — NEVER reported as success and NEVER blindly resubmitted. The
// order may already exist at the broker; the caller reconciles before any retry.
// ============================================================================

import { paths } from "./endpoints";
import type { TransportResult, WebullTransport } from "./transport";
import type {
  WebullNormalizedOrder,
  WebullOrderState,
  WebullOrderStatus,
  WebullPlaceResult,
  WebullTradeEnv,
} from "./types";

// Serialize a normalized order to the request body. This is the single mapping to
// wire field names; reconcile against current docs during the entitlement step.
export function serializeOrderBody(o: WebullNormalizedOrder): string {
  const body: Record<string, unknown> = {
    account_id: o.accountId,
    symbol: o.symbol,
    side: o.side,
    order_type: o.orderType,
    quantity: o.qty,
    time_in_force: o.timeInForce,
    session: o.session,
    client_order_id: o.clientOrderId,
  };
  if (o.orderType === "LIMIT") body.limit_price = o.limitPrice;
  if (o.orderType === "STOP_LOSS") body.stop_price = o.stopPrice;
  return JSON.stringify(body);
}

function pick(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  const data = obj.data ?? obj;
  for (const k of keys) {
    if (data && typeof data === "object" && data[k] != null) return data[k];
    if (obj[k] != null) return obj[k];
  }
  return undefined;
}

export function extractBrokerOrderId(json: unknown): string | undefined {
  const v = pick(json, ["order_id", "orderId", "id"]);
  if (typeof v === "string" && v.length >= 4) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

export async function placeOrder(
  transport: WebullTransport,
  order: WebullNormalizedOrder,
  env: WebullTradeEnv,
): Promise<WebullPlaceResult> {
  const body = serializeOrderBody(order);
  let res: TransportResult;
  try {
    res = await transport.send({ method: "POST", path: paths.place, body, env });
  } catch (e) {
    // Threw AFTER possibly sending → ambiguous, force reconcile.
    return { ok: false, needsReconcile: true, clientOrderId: order.clientOrderId, error: `place threw (possible send): ${String(e)}` };
  }

  if (!res.ok) {
    // Timeout is ALWAYS ambiguous. A definite HTTP rejection (non-timeout) is a
    // clean failure the caller may re-propose — but we still never auto-resubmit
    // here; the caller decides.
    if (res.timeout) {
      return { ok: false, needsReconcile: true, clientOrderId: order.clientOrderId, error: "place timed out — reconcile before any retry" };
    }
    return { ok: false, needsReconcile: false, clientOrderId: order.clientOrderId, error: res.error };
  }

  const brokerOrderId = extractBrokerOrderId(res.json);
  if (!brokerOrderId) {
    // Success status but no trackable id → cannot reconcile later; treat ambiguous.
    return { ok: false, needsReconcile: true, clientOrderId: order.clientOrderId, error: "place response had no parseable order id — reconcile before any retry", raw: res.json };
  }
  return { ok: true, brokerOrderId, clientOrderId: order.clientOrderId, raw: res.json };
}

export function mapWebullStatus(raw: string): WebullOrderStatus {
  const s = String(raw ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (!s) return "submitted";
  if (s.includes("partial")) return "partially_filled";
  if (s.includes("fill") || s === "filled" || s === "executed") return "filled";
  if (s.includes("cancel")) return "canceled";
  if (s.includes("reject") || s.includes("fail") || s.includes("denied")) return "rejected";
  if (s.includes("expire")) return "expired";
  return "submitted"; // pending/working/new/accepted/open → in-flight
}

export async function queryOrder(
  transport: WebullTransport,
  brokerOrderId: string,
  env: WebullTradeEnv,
): Promise<WebullOrderState> {
  let res: TransportResult;
  try {
    res = await transport.send({ method: "GET", path: paths.status, query: { order_id: brokerOrderId }, env });
  } catch (e) {
    return { ok: false, status: "needs_reconcile", error: `query threw: ${String(e)}` };
  }
  if (!res.ok) {
    return { ok: false, status: "needs_reconcile", error: res.timeout ? "query timed out" : res.error };
  }
  const rawStatus = pick(res.json, ["status", "order_status", "orderStatus", "state"]);
  const filledQty = Number(pick(res.json, ["filled_quantity", "filledQuantity", "cumulative_quantity", "executed_quantity"]));
  const avgFillPrice = Number(pick(res.json, ["avg_fill_price", "average_fill_price", "avg_price", "average_price", "averagePrice", "filled_price"]));
  return {
    ok: true,
    status: mapWebullStatus(String(rawStatus ?? "")),
    filledQty: Number.isFinite(filledQty) ? filledQty : undefined,
    avgFillPrice: Number.isFinite(avgFillPrice) ? avgFillPrice : undefined,
    raw: res.json,
  };
}

export async function cancelOrder(
  transport: WebullTransport,
  brokerOrderId: string,
  env: WebullTradeEnv,
): Promise<{ ok: boolean; error?: string; needsReconcile?: boolean }> {
  let res: TransportResult;
  try {
    res = await transport.send({ method: "POST", path: paths.cancel, body: JSON.stringify({ order_id: brokerOrderId }), env });
  } catch (e) {
    return { ok: false, needsReconcile: true, error: `cancel threw: ${String(e)}` };
  }
  if (!res.ok) {
    return { ok: false, needsReconcile: res.timeout, error: res.timeout ? "cancel timed out" : res.error };
  }
  return { ok: true };
}

// Reconcile an ambiguous place: look the order up by client_order_id (its
// idempotency key). Presence proves the earlier submit DID land — never resubmit.
export async function reconcileByClientOrderId(
  transport: WebullTransport,
  clientOrderId: string,
  env: WebullTradeEnv,
): Promise<WebullOrderState & { brokerOrderId?: string; found: boolean }> {
  let res: TransportResult;
  try {
    res = await transport.send({ method: "GET", path: paths.status, query: { client_order_id: clientOrderId }, env });
  } catch (e) {
    return { ok: false, found: false, status: "needs_reconcile", error: `reconcile threw: ${String(e)}` };
  }
  if (!res.ok) {
    return { ok: false, found: false, status: "needs_reconcile", error: res.timeout ? "reconcile timed out" : res.error };
  }
  const brokerOrderId = extractBrokerOrderId(res.json);
  if (!brokerOrderId) {
    // No order with this client id → the earlier submit did NOT land; safe to
    // re-propose upstream (the caller decides, not this module).
    return { ok: true, found: false, status: "needs_reconcile", raw: res.json };
  }
  const rawStatus = pick(res.json, ["status", "order_status", "orderStatus", "state"]);
  return { ok: true, found: true, brokerOrderId, status: mapWebullStatus(String(rawStatus ?? "")), raw: res.json };
}
