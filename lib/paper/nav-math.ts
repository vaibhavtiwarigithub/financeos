// Pure per-market NAV math. Currencies must NEVER be summed — computeNav
// throws if called with positions from more than one market, forcing every
// caller to aggregate per-market before calling this (see Codex review:
// mixing ₹ and $ in NAV/kill-switch math was the exact bug class this guards).

export interface NavPosition { market: "us" | "india"; qty: number; price: number }

export function computeNav(cashBalance: number, positions: NavPosition[]): number {
  const markets = new Set(positions.map(p => p.market));
  if (markets.size > 1) {
    throw new Error(`computeNav: mixed markets in one NAV calc (${[...markets].join(",")}) — currencies must never be summed`);
  }
  const positionsValue = positions.reduce((sum, p) => sum + p.qty * p.price, 0);
  return cashBalance + positionsValue;
}
