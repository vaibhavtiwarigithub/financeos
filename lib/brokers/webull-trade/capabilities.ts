// ============================================================================
// webull_trade — BrokerProtectiveCapabilities declaration.
// ----------------------------------------------------------------------------
// Declared per the shape in features/hybrid-stop/FEATURE_ARCHITECTURE.md
// §"Broker-Neutral Capability Matrix". Webull declares ONLY what the initial
// contract fixtures prove: US equity SELL-of-a-long protection via a GTC
// STOP_LOSS in the CORE (regular) session. The generic presence of ALL/NIGHT
// sessions elsewhere in the API does NOT prove a stop can trigger there, so those
// sessions are NOT declared. A flat broker-level boolean is forbidden.
//
// Uses the SHARED type from lib/protective/capabilities.ts (broker-neutral state
// machine). Note the shared `accountModes` means broker ENTITLEMENT (cash /
// margin / cnc / delivery) — NOT a session. Webull's "CORE" is its regular-session
// name and is declared under `sessions` below, where it belongs.
//
// `accountModes` is deliberately EMPTY: the Webull API entitlement for the
// intended account is UNCONFIRMED (open owner decision — see
// features/webull-trading-api §Open Owner Decisions #3). An empty list means
// evaluateProtection() returns unprotectedByBroker for every request, which is
// the correct fail-closed answer. Populate it ONLY once the real entitlement is
// verified — never guess, or the matrix asserts protection that was never proved.
// ============================================================================

import type { BrokerProtectiveCapabilities } from "./types";

export const WEBULL_TRADE_PROTECTIVE_CAPABILITIES: BrokerProtectiveCapabilities = {
  broker: "webull_trade",
  scope: {
    market: "us",
    instrumentTypes: ["equity"],
    sides: ["sell_long"], // protection is a risk-reducing SELL of a long; never a short
    accountModes: [],
  },
  orders: {
    // Modeled as a stop-market disaster floor: GTC, regular session only.
    stop_market: {
      timeInForce: ["gtc"],
      sessions: ["regular"], // regular/CORE only — extended/overnight NOT proven
      updateMode: "cancel_replace",
      maxLifetimeDays: null, // GTC persists across days; session eligibility is separate
      oco: false, // OCO/OTOCO out of initial scope
    },
  },
};
