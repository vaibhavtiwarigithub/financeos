// Per-market paper starting NAV — the baseline an equity curve's return % is
// measured against. NEVER measure a ₹ NAV against the US 10,000 seed: India's
// paper book seeds at ₹10,00,000, so a ₹9.8L NAV against 10,000 renders as
// +9,700% instead of -2%.
//
// This mirrors START_NAV in lib/kill-switches.ts. That copy guards the paper/live
// trade path and is deliberately NOT touched by display-only changes; if the seeds
// ever change, change both. Display surfaces should import from here.

import type { Mkt } from "@/lib/format-money";

export const PAPER_START_NAV: Record<Mkt, number> = { us: 10_000, india: 1_000_000 };

/** Paper seed NAV for a market, defaulting to the US book for unknown values. */
export function paperStartNav(market: Mkt): number {
  return PAPER_START_NAV[market] ?? PAPER_START_NAV.us;
}

/** Return % of a NAV point vs its own market's seed. Never cross-market. */
export function navReturnPct(nav: number, market: Mkt): number {
  const seed = paperStartNav(market);
  return +(((nav - seed) / seed) * 100).toFixed(2);
}
