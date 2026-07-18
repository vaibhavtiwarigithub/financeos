// ============================================================================
// webull_trade — the Mandatory Gate Ladder (spec §"Mandatory Gate Ladder").
// ----------------------------------------------------------------------------
// All 9 gates, evaluated IN ORDER, every one fail-closed. This is a PURE function
// over a snapshot of the relevant state — no DB, no network, deterministic — so
// it is fully testable and the adapter cannot reach the wire until every gate
// passes. Missing schema, config, account, credential, or broker response fails
// closed (unknown/undefined is never treated as satisfied).
// ============================================================================

import { assertTokenUsableForOrder } from "./token";
import type { WebullTokenRecord } from "./types";

export type GateId =
  | "global_trading_enabled"
  | "market_control_enabled"
  | "circuit_breakers_clear"
  | "autonomy_mode_satisfied"
  | "single_allowlisted_account"
  | "orders_feature_flag"
  | "credential_and_token"
  | "risk_checks"
  | "quantity_within_mandate";

export interface GateSnapshot {
  // 1. Global trading enabled and app not paused.
  globalTradingEnabled: boolean | null | undefined;
  appPaused: boolean | null | undefined;
  // 2. US market control enabled and kill switch clear.
  usMarketEnabled: boolean | null | undefined;
  usKillSwitchTripped: boolean | null | undefined;
  // 3. Drawdown/circuit breakers clear (for a BUY). Exits remain possible when
  //    entries halt — the caller passes `isExit` so a verified risk-reducing SELL
  //    is not blocked by a breaker that only halts new risk.
  circuitBreakerTrippedForBuy: boolean | null | undefined;
  isExit: boolean;
  // 4. Live autonomy/approval mode satisfied (owner-approved or authorized lease).
  autonomySatisfied: boolean | null | undefined;
  // 5. Exactly one enabled Webull trading account allowlisted for US.
  allowlistedWebullUsTradingAccounts: number | null | undefined;
  // 6. Explicit false-by-default feature flag.
  webullTradeOrdersEnabled: boolean | null | undefined;
  // 7. Valid credential + token + endpoint + acceptable timestamp skew.
  credentialPresent: boolean | null | undefined;
  token: WebullTokenRecord | null | undefined;
  endpointExpected: boolean | null | undefined; // host pinned & matches env
  timestampSkewAcceptable: boolean | null | undefined;
  // 8. Existing buying-power/notional/name/sector/gross/turnover/duplicate checks.
  riskChecksPassed: boolean | null | undefined;
  // 9. Deterministic quantity no greater than reconciled mandate allowance.
  qty: number | null | undefined;
  mandateMaxQty: number | null | undefined;
}

export type GateResult =
  | { ok: true }
  | { ok: false; failedGate: GateId; reason: string };

// Treat anything not-exactly-true as failure (fail closed on unknown/undefined).
function isTrue(v: unknown): boolean {
  return v === true;
}

export function evaluateGateLadder(s: GateSnapshot, now: number = Date.now()): GateResult {
  // 1
  if (!isTrue(s.globalTradingEnabled) || isTrue(s.appPaused)) {
    return { ok: false, failedGate: "global_trading_enabled", reason: "global trading disabled or app paused" };
  }
  // 2
  if (!isTrue(s.usMarketEnabled) || isTrue(s.usKillSwitchTripped)) {
    return { ok: false, failedGate: "market_control_enabled", reason: "US market control disabled or kill switch tripped" };
  }
  // 3 — a BUY is blocked by a breaker; a verified exit is not.
  if (!s.isExit && isTrue(s.circuitBreakerTrippedForBuy)) {
    return { ok: false, failedGate: "circuit_breakers_clear", reason: "circuit/drawdown breaker tripped for new risk" };
  }
  // 4
  if (!isTrue(s.autonomySatisfied)) {
    return { ok: false, failedGate: "autonomy_mode_satisfied", reason: "autonomy/approval mode not satisfied" };
  }
  // 5 — exactly one allowlisted account.
  if (s.allowlistedWebullUsTradingAccounts !== 1) {
    return {
      ok: false,
      failedGate: "single_allowlisted_account",
      reason: `expected exactly 1 allowlisted Webull US trading account, found ${s.allowlistedWebullUsTradingAccounts ?? "unknown"}`,
    };
  }
  // 6
  if (!isTrue(s.webullTradeOrdersEnabled)) {
    return { ok: false, failedGate: "orders_feature_flag", reason: "webull_trade_orders_enabled is false/absent" };
  }
  // 7
  if (!isTrue(s.credentialPresent) || !isTrue(s.endpointExpected) || !isTrue(s.timestampSkewAcceptable)) {
    return { ok: false, failedGate: "credential_and_token", reason: "credential/endpoint/timestamp not valid" };
  }
  if (!s.token) {
    return { ok: false, failedGate: "credential_and_token", reason: "no token record — failing closed" };
  }
  const tok = assertTokenUsableForOrder(s.token, now);
  if (!tok.usable) {
    return { ok: false, failedGate: "credential_and_token", reason: tok.reason };
  }
  // 8
  if (!isTrue(s.riskChecksPassed)) {
    return { ok: false, failedGate: "risk_checks", reason: "buying-power/notional/name/sector/gross/turnover/duplicate checks not passed" };
  }
  // 9
  if (!Number.isInteger(s.qty) || (s.qty as number) <= 0) {
    return { ok: false, failedGate: "quantity_within_mandate", reason: `qty ${s.qty} invalid` };
  }
  if (!Number.isFinite(s.mandateMaxQty as number) || (s.qty as number) > (s.mandateMaxQty as number)) {
    return { ok: false, failedGate: "quantity_within_mandate", reason: `qty ${s.qty} exceeds mandate allowance ${s.mandateMaxQty}` };
  }
  return { ok: true };
}
