import { assertTokenUsableForOrder } from "./token";
import type { WebullTokenRecord } from "./types";

export const APPROVED_ORDER_ACCOUNT_ID = "605420660";

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
  globalTradingEnabled: boolean | null | undefined;
  appPaused: boolean | null | undefined;
  usMarketEnabled: boolean | null | undefined;
  usKillSwitchTripped: boolean | null | undefined;
  circuitBreakerTrippedForBuy: boolean | null | undefined;
  side: "BUY" | "SELL";
  autonomySatisfied: boolean | null | undefined;
  allowlistedWebullUsTradingAccounts: number | null | undefined;
  orderAccountId: string | null | undefined;
  allowlistedAccountId: string | null | undefined;
  webullTradeOrdersEnabled: boolean | null | undefined;
  credentialPresent: boolean | null | undefined;
  token: WebullTokenRecord | null | undefined;
  endpointExpected: boolean | null | undefined;
  timestampSkewAcceptable: boolean | null | undefined;
  riskChecksPassed: boolean | null | undefined;
  qty: number | null | undefined;
  mandateMaxQty: number | null | undefined;
  reconciledHeldQty: number | null | undefined;
  restingExecutableSellQty: number | null | undefined;
}

export type GateResult = { ok: true } | { ok: false; failedGate: GateId; reason: string };

export function evaluateGateLadder(s: GateSnapshot, now: number = Date.now()): GateResult {
  if (s.globalTradingEnabled !== true || s.appPaused !== false) {
    return { ok: false, failedGate: "global_trading_enabled", reason: "global state is not explicitly enabled and unpaused" };
  }
  if (s.usMarketEnabled !== true || s.usKillSwitchTripped !== false) {
    return { ok: false, failedGate: "market_control_enabled", reason: "US market is not explicitly enabled with kill switch clear" };
  }
  if (s.side === "BUY" && s.circuitBreakerTrippedForBuy !== false) {
    return { ok: false, failedGate: "circuit_breakers_clear", reason: "BUY breaker state is tripped or unknown" };
  }
  if (s.autonomySatisfied !== true) {
    return { ok: false, failedGate: "autonomy_mode_satisfied", reason: "autonomy/approval mode not satisfied" };
  }
  if (s.allowlistedWebullUsTradingAccounts !== 1) {
    return { ok: false, failedGate: "single_allowlisted_account", reason: "expected exactly one allowlisted Webull US trading account" };
  }
  if (!s.orderAccountId || !s.allowlistedAccountId || s.orderAccountId !== s.allowlistedAccountId || s.orderAccountId !== APPROVED_ORDER_ACCOUNT_ID) {
    return { ok: false, failedGate: "single_allowlisted_account", reason: "order account does not exactly match the resolved allowlist" };
  }
  if (s.webullTradeOrdersEnabled !== true) {
    return { ok: false, failedGate: "orders_feature_flag", reason: "webull_trade_orders_enabled is false or absent" };
  }
  if (s.credentialPresent !== true || s.endpointExpected !== true || s.timestampSkewAcceptable !== true || !s.token) {
    return { ok: false, failedGate: "credential_and_token", reason: "credential, token, endpoint, or timestamp is not proven valid" };
  }
  const token = assertTokenUsableForOrder(s.token, now);
  if (!token.usable) return { ok: false, failedGate: "credential_and_token", reason: token.reason };
  if (s.riskChecksPassed !== true) {
    return { ok: false, failedGate: "risk_checks", reason: "risk checks not passed" };
  }
  if (!Number.isInteger(s.qty) || (s.qty as number) <= 0 || !Number.isInteger(s.mandateMaxQty) || (s.mandateMaxQty as number) < 0) {
    return { ok: false, failedGate: "quantity_within_mandate", reason: "quantity or mandate allowance is invalid" };
  }
  if ((s.qty as number) > (s.mandateMaxQty as number)) {
    return { ok: false, failedGate: "quantity_within_mandate", reason: "quantity exceeds mandate allowance" };
  }
  if (s.side === "SELL") {
    if (!Number.isFinite(s.reconciledHeldQty) || (s.reconciledHeldQty as number) < 0) {
      return { ok: false, failedGate: "quantity_within_mandate", reason: "SELL held quantity is unknown or invalid" };
    }
    if (!Number.isFinite(s.restingExecutableSellQty) || (s.restingExecutableSellQty as number) < 0) {
      return { ok: false, failedGate: "quantity_within_mandate", reason: "resting SELL quantity is unknown or invalid" };
    }
    if ((s.qty as number) + (s.restingExecutableSellQty as number) > (s.reconciledHeldQty as number)) {
      return { ok: false, failedGate: "quantity_within_mandate", reason: "SELL plus resting SELL would exceed reconciled holdings" };
    }
  }
  return { ok: true };
}
