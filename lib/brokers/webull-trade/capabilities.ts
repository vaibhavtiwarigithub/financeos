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
// DEPENDENCY: the shared BrokerProtectiveCapabilities type is not yet on `main`.
// This declaration uses the local shape in ./types (identical to the spec). When
// the shared type lands from features/hybrid-stop, swap the import and keep this
// VALUE unchanged.
// ============================================================================

import type { BrokerProtectiveCapabilities } from "./types";

export const WEBULL_TRADE_PROTECTIVE_CAPABILITIES: BrokerProtectiveCapabilities = {
  scope: {
    market: "us",
    instrumentTypes: ["equity"],
    sides: ["sell_long"], // protection is a risk-reducing SELL of a long; never a short
    accountModes: ["CORE"],
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
