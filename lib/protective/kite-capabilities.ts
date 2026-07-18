// Hybrid protective stops — KITE capability declaration (shadow scaffold).
//
// Declared from the PROVEN existing GTT code (lib/kite.ts `placeKiteGtt` /
// `cancelKiteGtt` / `buildKiteGttBody`). This module DECLARES what Kite supports;
// it never places, modifies, or cancels anything.
//
// What the proven code establishes:
//   - GTT is placed with CNC (delivery) product only (buildKiteGttBody).
//   - GTT children are LIMIT, INCLUDING the stop-side child (Kite GTT API accepts
//     LIMIT children only). So the Kite disaster floor is a stop-LIMIT / gtt_limit:
//     the trigger and limit intentionally match, and a gap through the limit can
//     leave it UNFILLED — genuinely weaker than a stop-market.
//   - GTT is broker-managed and persists across trading days (it is not a DAY
//     order renewed as hidden cron state).
//   - GTT can be modified in place (Kite PUT /gtt/triggers/:id) and returns an
//     expiry; two-leg GTT is an OCO bracket.
//   - A Kite REGULAR SL / SL-M order is DAY/IOC only — NOT a multi-day substitute
//     for GTT (spec §"Verified Broker Capabilities"). So it is declared with a
//     DAY-only TIF, which the eligibility query correctly REJECTS for any
//     multi-day disaster floor. Declaring it honestly (rather than omitting it)
//     is what makes "Kite is protected by GTT, NOT by a multi-day stop-market"
//     a falsifiable, inspectable fact.

import { BrokerProtectiveCapabilities } from "@/lib/protective/capabilities";

// Kite GTT maximum validity is ~1 year (365 days) from creation.
export const KITE_GTT_MAX_LIFETIME_DAYS = 365;

export const KITE_PROTECTIVE_CAPABILITIES: BrokerProtectiveCapabilities = {
  broker: "kite",
  scope: {
    market: "india",
    instrumentTypes: ["equity"],
    sides: ["sell_long"],
    // placeKiteGtt / placeEquityOrder use product CNC (delivery).
    accountModes: ["cnc", "delivery"],
  },
  orders: {
    // The PROVEN protective path: two-leg GTT with LIMIT children.
    gtt_limit: {
      // Broker-managed lifecycle — persists across trading days without a DAY renewal.
      timeInForce: ["broker_managed"],
      // Kite GTT triggers in the regular cash session only.
      sessions: ["regular"],
      // Kite supports GTT modify-in-place (PUT). NOTE: the SHIPPED standalone
      // route currently uses cancel-before-replace for explicit exits; the
      // capability declaration states what Kite CAN do, and the reconciliation
      // protocol chooses modify-in-place where it can, cancel/replace otherwise.
      updateMode: "modify_in_place",
      maxLifetimeDays: KITE_GTT_MAX_LIFETIME_DAYS,
      oco: true,
    },
    // Declared honestly as DAY-only so the eligibility query rejects it as a
    // multi-day floor. This is NOT a stop-market disaster floor for Kite — a
    // regular SL-M is not a multi-day substitute for GTT.
    stop_market: {
      timeInForce: ["day"],
      sessions: ["regular"],
      updateMode: "cancel_replace",
      maxLifetimeDays: 1,
      oco: false,
    },
  },
};
