// ============================================================================
// webull_trade — order normalization + reject rules at the adapter boundary.
// ----------------------------------------------------------------------------
// Initial order-type scope is LOCKED small (spec):
//   - MARKET + LIMIT for manual-approved entries
//   - GTC STOP_LOSS in CORE as the disaster floor only
// Everything else is rejected HERE, before signing/sending, even though the
// Webull API documents it:
//   - side SHORT                → long-only enforcement (capability != permission)
//   - options instruments       → equities only
//   - trailing / OCO / OTOCO / algos (TWAP/VWAP/POV) → out of scope
//   - extended / overnight sessions → CORE only
//   - TIF other than DAY/GTC, and STOP_LOSS with a non-GTC TIF
// ============================================================================

import { isValidClientOrderId } from "./client-order-id";
import type {
  NormalizeResult,
  WebullNormalizedOrder,
  WebullOrderRequest,
  WebullSide,
  WebullTimeInForce,
} from "./types";

const ALLOWED_ORDER_TYPES = new Set(["MARKET", "LIMIT", "STOP_LOSS"]);
const ALLOWED_TIF = new Set(["DAY", "GTC"]);

function up(s: string | undefined): string {
  return String(s ?? "").trim().toUpperCase();
}

export function normalizeOrder(req: WebullOrderRequest): NormalizeResult {
  // Required identity fields.
  if (!req.accountId || !req.symbol) {
    return { ok: false, code: "missing_field", error: "accountId and symbol are required" };
  }
  if (!isValidClientOrderId(req.clientOrderId)) {
    return { ok: false, code: "client_order_id_invalid", error: "clientOrderId missing or invalid (<=32 alphanumeric)" };
  }

  // Instrument: equities only.
  const instrument = up(req.instrumentType) || "EQUITY";
  if (instrument !== "EQUITY" && instrument !== "STOCK") {
    return { ok: false, code: "options_instrument", error: `instrument '${req.instrumentType}' rejected — equities only (no options)` };
  }

  // Side: long-only. SHORT rejected even though the API accepts it.
  const side = up(req.side);
  if (side === "SHORT" || side === "SELL_SHORT") {
    return { ok: false, code: "short_side", error: "SHORT rejected at adapter boundary (long-only)" };
  }
  if (side !== "BUY" && side !== "SELL") {
    return { ok: false, code: "short_side", error: `side '${req.side}' not allowed (BUY/SELL only)` };
  }

  // Order type: locked scope.
  const orderType = up(req.orderType);
  if (!ALLOWED_ORDER_TYPES.has(orderType)) {
    return {
      ok: false,
      code: "unsupported_order_type",
      error: `orderType '${req.orderType}' rejected — only MARKET, LIMIT, GTC STOP_LOSS in scope`,
    };
  }

  // Session: CORE only.
  const session = up(req.session) || "CORE";
  if (session !== "CORE") {
    return { ok: false, code: "unsupported_session", error: `session '${req.session}' rejected — CORE only` };
  }

  // Qty: positive integer (no fractional in scope).
  if (!Number.isInteger(req.qty) || req.qty <= 0) {
    return { ok: false, code: "invalid_qty", error: `qty ${req.qty} invalid — positive integer required` };
  }

  // TIF rules.
  const tifRaw = up(req.timeInForce) || (orderType === "STOP_LOSS" ? "GTC" : "DAY");
  if (!ALLOWED_TIF.has(tifRaw)) {
    return { ok: false, code: "unsupported_tif", error: `timeInForce '${req.timeInForce}' rejected — DAY/GTC only` };
  }
  const timeInForce = tifRaw as WebullTimeInForce;

  // Type-specific price + TIF constraints.
  if (orderType === "LIMIT") {
    if (!(Number.isFinite(req.limitPrice) && (req.limitPrice as number) > 0)) {
      return { ok: false, code: "missing_limit_price", error: "LIMIT order requires a positive limitPrice" };
    }
  }
  if (orderType === "STOP_LOSS") {
    // Disaster floor is a GTC STOP_LOSS in CORE only.
    if (timeInForce !== "GTC") {
      return { ok: false, code: "unsupported_tif_for_type", error: "STOP_LOSS is in scope only as GTC (disaster floor)" };
    }
    if (!(Number.isFinite(req.stopPrice) && (req.stopPrice as number) > 0)) {
      return { ok: false, code: "missing_stop_price", error: "STOP_LOSS order requires a positive stopPrice" };
    }
  }

  const order: WebullNormalizedOrder = {
    accountId: req.accountId,
    symbol: req.symbol.toUpperCase(),
    side: side as WebullSide,
    orderType: orderType as WebullNormalizedOrder["orderType"],
    qty: req.qty,
    limitPrice: orderType === "LIMIT" ? req.limitPrice : undefined,
    stopPrice: orderType === "STOP_LOSS" ? req.stopPrice : undefined,
    timeInForce,
    session: "CORE",
    clientOrderId: req.clientOrderId,
  };
  return { ok: true, order };
}
