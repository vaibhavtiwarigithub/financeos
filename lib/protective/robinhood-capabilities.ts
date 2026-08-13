// Hybrid protective stops — ROBINHOOD capability declaration.
//
// Declared from the Robinhood MCP adapter (lib/robinhood-mcp.ts). This module
// DECLARES what Robinhood supports; it never places, modifies, or cancels anything.
//
// Key facts about RH GTC stop-market orders:
//   - A GTC stop-market converts to a market order when triggered — execution
//     and fill price are NOT guaranteed (gap-through = filled at gap price, not stop).
//   - RH GTC stops trigger only in the REGULAR session (9:30–16:00 ET).
//     They do NOT trigger pre-market or after-hours, so overnight gaps are still
//     not covered until regular session opens.
//   - RH has no OCO bracket product — stop and target must be managed separately.
//   - No documented broker-imposed lifetime cap on GTC orders.
//
// This is genuinely STRONGER than Kite GTT (which uses LIMIT children and can
// remain unfilled on a gap) but still has the "no pre-market trigger" gap.

import { BrokerProtectiveCapabilities } from "@/lib/protective/capabilities";

export const ROBINHOOD_PROTECTIVE_CAPABILITIES: BrokerProtectiveCapabilities = {
  broker: "robinhood",
  scope: {
    market: "us",
    instrumentTypes: ["equity"],
    sides: ["sell_long"],
    // RH cash and margin accounts both support GTC stop-market.
    accountModes: ["cash", "margin"],
  },
  orders: {
    // GTC stop-market: the proven protective path for US equity.
    // Converts to a market SELL when stop_price is touched — fills at
    // whatever the market will bear (no limit floor, but you ARE out).
    stop_market: {
      timeInForce: ["gtc"],
      // RH GTC stop-market ONLY triggers in regular session.
      // Pre-market and after-hours: order sits dormant, does NOT trigger.
      sessions: ["regular"],
      // RH has no in-place modify — must cancel then replace.
      updateMode: "cancel_replace",
      maxLifetimeDays: null, // no documented cap
      oco: false,
    },
  },
};
