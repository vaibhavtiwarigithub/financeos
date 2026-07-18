// webull_trade — gate ladder (all 9 fail closed), order normalization rejects,
// token lifecycle. Covers Failure Tests 2, 3, 4, 11, 13, 14.
import { describe, it, expect } from "vitest";
import { evaluateGateLadder, GateSnapshot } from "@/lib/brokers/webull-trade/gates";
import { normalizeOrder } from "@/lib/brokers/webull-trade/order";
import {
  assertTokenUsableForOrder,
  shouldAlertIdle,
  isWithinVerifyWindow,
  IDLE_INVALID_DAYS,
} from "@/lib/brokers/webull-trade/token";
import type { WebullOrderRequest, WebullTokenRecord } from "@/lib/brokers/webull-trade/types";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const freshToken: WebullTokenRecord = {
  status: "NORMAL",
  lastAuthenticatedCallAt: "2026-07-18T00:00:00Z",
  serverStatusCheckedAt: "2026-07-18T11:55:00Z",
  expiresAt: "2026-08-18T00:00:00Z",
};

// A fully-passing snapshot; each test flips exactly one field to prove that gate
// fails closed and blocks BEFORE any network access.
function passingSnapshot(): GateSnapshot {
  return {
    globalTradingEnabled: true,
    appPaused: false,
    usMarketEnabled: true,
    usKillSwitchTripped: false,
    circuitBreakerTrippedForBuy: false,
    side: "BUY",
    autonomySatisfied: true,
    allowlistedWebullUsTradingAccounts: 1,
    orderAccountId: "605420660",
    allowlistedAccountId: "605420660",
    webullTradeOrdersEnabled: true,
    credentialPresent: true,
    token: freshToken,
    endpointExpected: true,
    timestampSkewAcceptable: true,
    riskChecksPassed: true,
    qty: 5,
    mandateMaxQty: 10,
    reconciledHeldQty: 10,
    restingExecutableSellQty: 0,
  };
}

describe("webull_trade gate ladder", () => {
  it("passes only when every gate is satisfied", () => {
    expect(evaluateGateLadder(passingSnapshot(), NOW)).toEqual({ ok: true });
  });

  const flips: { field: keyof GateSnapshot; value: any; gate: string }[] = [
    { field: "globalTradingEnabled", value: false, gate: "global_trading_enabled" },
    { field: "appPaused", value: true, gate: "global_trading_enabled" },
    { field: "usMarketEnabled", value: false, gate: "market_control_enabled" },
    { field: "usKillSwitchTripped", value: true, gate: "market_control_enabled" },
    { field: "circuitBreakerTrippedForBuy", value: true, gate: "circuit_breakers_clear" },
    { field: "autonomySatisfied", value: false, gate: "autonomy_mode_satisfied" },
    { field: "allowlistedWebullUsTradingAccounts", value: 0, gate: "single_allowlisted_account" },
    { field: "allowlistedWebullUsTradingAccounts", value: 2, gate: "single_allowlisted_account" },
    { field: "webullTradeOrdersEnabled", value: false, gate: "orders_feature_flag" },
    { field: "credentialPresent", value: false, gate: "credential_and_token" },
    { field: "endpointExpected", value: false, gate: "credential_and_token" },
    { field: "timestampSkewAcceptable", value: false, gate: "credential_and_token" },
    { field: "riskChecksPassed", value: false, gate: "risk_checks" },
    { field: "mandateMaxQty", value: 4, gate: "quantity_within_mandate" }, // qty 5 > 4
  ];

  for (const f of flips) {
    it(`fails closed on gate ${f.gate} when ${String(f.field)}=${JSON.stringify(f.value)}`, () => {
      const snap = { ...passingSnapshot(), [f.field]: f.value };
      const r = evaluateGateLadder(snap, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failedGate).toBe(f.gate);
    });
  }

  it("fails closed when a required field is undefined/unknown (never treats unknown as satisfied)", () => {
    const snap = { ...passingSnapshot(), globalTradingEnabled: undefined };
    expect(evaluateGateLadder(snap, NOW).ok).toBe(false);
  });

  it("TWO allowlisted accounts fail closed as ambiguous (Test 3)", () => {
    const snap = { ...passingSnapshot(), allowlistedWebullUsTradingAccounts: 2 };
    const r = evaluateGateLadder(snap, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failedGate).toBe("single_allowlisted_account");
  });

  it("a verified EXIT is not blocked by a circuit breaker that only halts new risk", () => {
    const snap = { ...passingSnapshot(), circuitBreakerTrippedForBuy: true, side: "SELL" as const };
    expect(evaluateGateLadder(snap, NOW)).toEqual({ ok: true });
  });

  it("unknown pause, kill-switch, and BUY breaker states fail closed", () => {
    for (const field of ["appPaused", "usKillSwitchTripped", "circuitBreakerTrippedForBuy"] as const) {
      expect(evaluateGateLadder({ ...passingSnapshot(), [field]: undefined }, NOW).ok).toBe(false);
    }
  });

  it("SELL cannot exceed holdings after accounting for resting executable sells", () => {
    const snap = { ...passingSnapshot(), side: "SELL" as const, qty: 6, restingExecutableSellQty: 5, reconciledHeldQty: 10 };
    expect(evaluateGateLadder(snap, NOW).ok).toBe(false);
  });

  it("order account must exactly match the single resolved allowlist account", () => {
    expect(evaluateGateLadder({ ...passingSnapshot(), orderAccountId: "OTHER" }, NOW).ok).toBe(false);
  });

  it("an INVALID/EXPIRED/UNKNOWN/idle token fails the credential gate (Test 13)", () => {
    for (const status of ["INVALID", "EXPIRED", "UNKNOWN"] as const) {
      const snap = { ...passingSnapshot(), token: { status, lastAuthenticatedCallAt: "2026-07-18T00:00:00Z" } };
      const r = evaluateGateLadder(snap, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failedGate).toBe("credential_and_token");
    }
    // 15-day idle NORMAL token still fails closed
    const idle = { ...passingSnapshot(), token: { status: "NORMAL", lastAuthenticatedCallAt: "2026-06-01T00:00:00Z" } as WebullTokenRecord };
    expect(evaluateGateLadder(idle, NOW).ok).toBe(false);
  });
});

describe("webull_trade order normalization — reject at boundary (Test 4)", () => {
  function base(): WebullOrderRequest {
    return { accountId: "WBACCT1", symbol: "AAPL", side: "BUY", orderType: "MARKET", qty: 2, clientOrderId: "kai0abc" };
  }

  it("accepts a MARKET buy", () => {
    const r = normalizeOrder(base());
    expect(r.ok).toBe(true);
  });

  it("accepts a LIMIT buy with a positive limit price", () => {
    const r = normalizeOrder({ ...base(), orderType: "LIMIT", limitPrice: 190.5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order.limitPrice).toBe(190.5);
  });

  it("accepts a GTC STOP_LOSS in CORE with a stop price", () => {
    const r = normalizeOrder({ ...base(), side: "SELL", orderType: "STOP_LOSS", timeInForce: "GTC", stopPrice: 150 });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.order.orderType).toBe("STOP_LOSS"); expect(r.order.timeInForce).toBe("GTC"); }
  });

  it("rejects SHORT (long-only)", () => {
    const r = normalizeOrder({ ...base(), side: "SHORT" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("short_side");
  });

  it("rejects options instruments", () => {
    const r = normalizeOrder({ ...base(), instrumentType: "OPTION" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("options_instrument");
  });

  it("rejects trailing/OCO/algo order types", () => {
    for (const t of ["TRAILING_STOP", "OCO", "OTOCO", "TWAP", "VWAP", "POV", "STOP_LIMIT"]) {
      const r = normalizeOrder({ ...base(), orderType: t });
      expect(r.ok, `${t} should reject`).toBe(false);
      if (!r.ok) expect(r.code).toBe("unsupported_order_type");
    }
  });

  it("rejects extended/overnight sessions (CORE only)", () => {
    for (const s of ["EXTENDED", "OVERNIGHT", "ALL", "NIGHT"]) {
      const r = normalizeOrder({ ...base(), session: s });
      expect(r.ok, `${s} should reject`).toBe(false);
      if (!r.ok) expect(r.code).toBe("unsupported_session");
    }
  });

  it("rejects STOP_LOSS with a non-GTC TIF", () => {
    const r = normalizeOrder({ ...base(), side: "SELL", orderType: "STOP_LOSS", timeInForce: "DAY", stopPrice: 150 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_tif_for_type");
  });

  it("rejects non-integer / non-positive qty", () => {
    expect(normalizeOrder({ ...base(), qty: 0 }).ok).toBe(false);
    expect(normalizeOrder({ ...base(), qty: 1.5 }).ok).toBe(false);
    expect(normalizeOrder({ ...base(), qty: -3 }).ok).toBe(false);
  });

  it("rejects a LIMIT with no/invalid price and a STOP_LOSS with no stop", () => {
    expect(normalizeOrder({ ...base(), orderType: "LIMIT" }).ok).toBe(false);
    expect(normalizeOrder({ ...base(), side: "SELL", orderType: "STOP_LOSS", timeInForce: "GTC" }).ok).toBe(false);
  });

  it("rejects an invalid/too-long client_order_id", () => {
    expect(normalizeOrder({ ...base(), clientOrderId: "" }).ok).toBe(false);
    expect(normalizeOrder({ ...base(), clientOrderId: "x".repeat(33) }).ok).toBe(false);
    expect(normalizeOrder({ ...base(), clientOrderId: "has space" }).ok).toBe(false);
  });
});

describe("webull_trade token lifecycle", () => {
  it("NORMAL + fresh is usable", () => {
    expect(assertTokenUsableForOrder(freshToken, NOW)).toEqual({ usable: true });
  });

  it("fails closed on missing last-call timestamp (freshness unknown)", () => {
    const r = assertTokenUsableForOrder({ status: "NORMAL", lastAuthenticatedCallAt: null }, NOW);
    expect(r.usable).toBe(false);
  });

  it("fails closed at/after 15 idle days even if server still says NORMAL", () => {
    const last = new Date(NOW - IDLE_INVALID_DAYS * 24 * 60 * 60 * 1000 - 1000).toISOString();
    expect(assertTokenUsableForOrder({ status: "NORMAL", lastAuthenticatedCallAt: last }, NOW).usable).toBe(false);
  });

  it("raises a pre-boundary idle alert but not before the margin", () => {
    const day = 24 * 60 * 60 * 1000;
    const at13 = new Date(NOW - 13 * day).toISOString();
    const at10 = new Date(NOW - 10 * day).toISOString();
    expect(shouldAlertIdle({ status: "NORMAL", lastAuthenticatedCallAt: at13 }, NOW)).toBe(true);
    expect(shouldAlertIdle({ status: "NORMAL", lastAuthenticatedCallAt: at10 }, NOW)).toBe(false);
  });

  it("verify window: within 5 min ok, later expired", () => {
    const minted = "2026-07-18T12:00:00Z";
    const m = Date.parse(minted);
    expect(isWithinVerifyWindow(minted, m + 4 * 60 * 1000)).toBe(true);
    expect(isWithinVerifyWindow(minted, m + 6 * 60 * 1000)).toBe(false);
    expect(isWithinVerifyWindow(null, m)).toBe(false);
  });
});
