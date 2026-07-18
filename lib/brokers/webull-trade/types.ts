// ============================================================================
// webull_trade — shared types for the SIGNED Webull Trading API adapter.
// ----------------------------------------------------------------------------
// This is the separate, signed REST/gRPC money-path integration described in
// features/webull-trading-api/FEATURE_ARCHITECTURE.md. It is DISTINCT from the
// read-only Cloud MCP registry (`webull` in lib/brokers/mcp-registry.ts), which
// stays query-only. The two transports, credentials, scopes, and registries
// must never be combined.
//
// EVERYTHING here is disabled by default and exercised only against fixtures.
// There is no live order and no live/sandbox network call anywhere in this
// module — the live transport fails closed until the owner confirms entitlement
// and runs a manually-approved sandbox test (see transport.ts).
// ============================================================================

// Sandbox and prod are SEPARATE environments with SEPARATE vault records and
// SEPARATE hosts. A sandbox credential can never resolve a prod host.
export type WebullTradeEnv = "sandbox" | "prod";

// Initial order-type scope is LOCKED small (spec §"Initial order-type scope"):
//   - MARKET + LIMIT for manual-approved entries
//   - GTC STOP_LOSS in CORE as the disaster floor only
// Everything else (SHORT, options, OCO/OTOCO, trailing, algos, extended/overnight
// sessions) is rejected at the adapter boundary even though the API documents it.
export type WebullOrderType = "MARKET" | "LIMIT" | "STOP_LOSS";

// Long-only is enforced. `SHORT` is rejected at the adapter boundary even though
// the Webull API accepts it — a capability is not a permission.
export type WebullSide = "BUY" | "SELL";

export type WebullTimeInForce = "DAY" | "GTC";

// Only the regular/core session is in scope. GTC alone never proves a stop can
// trigger in extended or overnight sessions (spec + hybrid-stop matrix).
export type WebullSession = "CORE";

// The canonical, adapter-normalized order BEFORE it is signed and sent. It is the
// only shape the transport accepts; every field is deterministic.
export interface WebullNormalizedOrder {
  accountId: string;
  symbol: string;
  side: WebullSide;
  orderType: WebullOrderType;
  qty: number;               // whole shares, positive integer (no fractional in scope)
  limitPrice?: number;       // required for LIMIT
  stopPrice?: number;        // required for STOP_LOSS
  timeInForce: WebullTimeInForce;
  session: WebullSession;
  clientOrderId: string;     // stable, <=32 chars
}

// The raw request an adapter caller hands to normalizeOrder(). Intentionally
// wider than WebullNormalizedOrder so we can REJECT the out-of-scope inputs
// (short, options, algos, OCO, trailing, extended sessions) at the boundary.
export interface WebullOrderRequest {
  accountId: string;
  symbol: string;
  side: string;              // may be "SHORT" — rejected
  orderType: string;         // may be "TRAILING_STOP" / "OCO" / ... — rejected
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: string;
  session?: string;
  instrumentType?: string;   // may be "OPTION" — rejected
  clientOrderId: string;
}

export type NormalizeResult =
  | { ok: true; order: WebullNormalizedOrder }
  | { ok: false; error: string; code: WebullRejectCode };

export type WebullRejectCode =
  | "short_side"
  | "options_instrument"
  | "unsupported_order_type"
  | "unsupported_session"
  | "unsupported_tif"
  | "unsupported_tif_for_type"
  | "invalid_qty"
  | "missing_limit_price"
  | "missing_stop_price"
  | "client_order_id_invalid"
  | "missing_field";

// ── Order lifecycle ─────────────────────────────────────────────────────────
// A place attempt is either a tracked success (broker order id) or an AMBIGUOUS
// outcome that must be reconciled — a timeout, a transport error after send, or
// a "success" response carrying no parseable order id. It is NEVER reported as a
// plain success and NEVER blindly resubmitted.
export type WebullPlaceResult =
  | { ok: true; brokerOrderId: string; clientOrderId: string; raw?: unknown }
  | { ok: false; needsReconcile: true; clientOrderId: string; error: string; raw?: unknown }
  | { ok: false; needsReconcile: false; clientOrderId: string; error: string; raw?: unknown };

export type WebullOrderStatus =
  | "submitted"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  | "needs_reconcile";

export interface WebullOrderState {
  ok: boolean;
  status?: WebullOrderStatus;
  filledQty?: number;
  avgFillPrice?: number;
  raw?: unknown;
  error?: string;
}

// ── Token lifecycle (spec §"Verified Trading API Facts") ────────────────────
// The Webull server marks a token:
//   - NORMAL   : reusable, in-date
//   - INVALID  : 15 consecutive days without an API call
//   - EXPIRED  : initial 2FA verification not completed within 5 minutes
// Kairos tracks the last confirmed authenticated call, checks status before
// order activity after an idle interval, and fails CLOSED on invalid/expired/
// unknown. It must not generate keepalive traffic merely to hide an unused
// credential.
export type WebullTokenStatus = "NORMAL" | "INVALID" | "EXPIRED" | "UNKNOWN";

export interface WebullTokenRecord {
  status: WebullTokenStatus;
  // ISO timestamp of the last confirmed authenticated call (drives idle checks).
  lastAuthenticatedCallAt: string | null;
  // ISO timestamp the token was first minted (drives the 5-minute verify window).
  mintedAt?: string | null;
}

export type TokenCheckResult =
  | { usable: true }
  | { usable: false; reason: string; status: WebullTokenStatus | "idle_expired" };

// ── BrokerProtectiveCapabilities ────────────────────────────────────────────
// The shared broker-neutral type now lives in lib/protective/capabilities.ts
// (landed with features/hybrid-stop). This module re-exports it so there is
// exactly ONE definition of the capability matrix in the codebase — a second
// local copy could drift and let an adapter declare protection the shared state
// machine would never honour.
export type {
  Market,
  InstrumentType,
  AccountMode,
  BrokerProtectiveCapabilities,
} from "@/lib/protective/capabilities";
