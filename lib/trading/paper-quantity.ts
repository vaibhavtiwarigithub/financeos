export type PaperQuantityMarket = "us" | "india";

const US_FRACTIONAL_SCALE = 1_000_000;

/** Desired allocation before funding: a cash shortage must reach rotation. */
export function paperIntendedSpend(portfolioNav: unknown, sizePct: unknown, orderCap?: unknown): number | null {
  const nav = finitePositive(portfolioNav);
  const pct = finitePositive(sizePct);
  const cap = orderCap == null ? Infinity : finitePositive(orderCap);
  if (nav == null || pct == null || cap == null) return null;
  const spend = Math.min(nav * pct / 100, cap);
  return Number.isFinite(spend) && spend > 0 ? spend : null;
}

function finitePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Convert a NAV allocation percentage into a cash-bounded paper budget. */
export function paperAllocationSpend(
  portfolioNav: unknown,
  cashBalance: unknown,
  sizePct: unknown,
  orderCap?: unknown,
): number | null {
  const nav = finitePositive(portfolioNav);
  const cash = finitePositive(cashBalance);
  const pct = finitePositive(sizePct);
  if (nav == null || cash == null || pct == null) return null;

  const rawCap = orderCap == null ? Number.POSITIVE_INFINITY : Number(orderCap);
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : Number.POSITIVE_INFINITY;
  const spend = Math.min(nav * (pct / 100), cash, cap);
  return Number.isFinite(spend) && spend > 0 ? spend : null;
}

/**
 * Converts a paper allocation into an executable market-local quantity without
 * ever rounding up over its cash budget. US paper supports six-decimal fractions;
 * India remains whole-share until an explicit broker capability is established.
 */
export function paperEntryQuantity(
  market: PaperQuantityMarket,
  maxSpend: unknown,
  fillPrice: unknown,
): number | null {
  const spend = finitePositive(maxSpend);
  const price = finitePositive(fillPrice);
  if (spend == null || price == null) return null;

  const raw = spend / price;
  const qty = market === "us"
    ? Math.floor(raw * US_FRACTIONAL_SCALE) / US_FRACTIONAL_SCALE
    : Math.floor(raw);
  return Number.isFinite(qty) && qty > 0 ? qty : null;
}

/** Downsize an approved paper BUY to the remaining daily allowance, never upsize it. */
export function paperDailyCapQuantity(
  market: PaperQuantityMarket,
  proposedQty: unknown,
  fillPrice: unknown,
  spentToday: unknown,
  dailyCap: unknown,
): number | null {
  const proposed = finitePositive(proposedQty);
  const price = finitePositive(fillPrice);
  const spent = typeof spentToday === "number" ? spentToday : NaN;
  const cap = finitePositive(dailyCap);
  if (proposed == null || price == null || cap == null || !Number.isFinite(spent) || spent < 0) return null;

  const remaining = cap - spent;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const affordable = paperEntryQuantity(market, remaining, price);
  if (affordable == null) return null;

  const scale = market === "us" ? US_FRACTIONAL_SCALE : 1;
  let units = Math.floor(Math.min(proposed, affordable) * scale);
  // Floating-point multiplication may straddle a decimal cap boundary. Err
  // below the cap; the locked database RPC is still the final authority.
  while (units > 0 && units / scale * price > remaining) units -= 1;
  return units > 0 ? units / scale : null;
}

/** Returns a partial-target sell quantity or null when the position must close whole. */
export function paperPartialTargetQuantity(market: PaperQuantityMarket, heldQty: unknown): number | null {
  const qty = finitePositive(heldQty);
  if (qty == null) return null;
  if (market === "india") {
    const half = Math.floor(qty / 2);
    return half >= 1 && qty - half >= 1 ? half : null;
  }

  const half = Math.floor((qty / 2) * US_FRACTIONAL_SCALE) / US_FRACTIONAL_SCALE;
  return half > 0 && qty - half > 0 ? half : null;
}

/** A partial-target exit may tighten runner protection, but must never loosen it. */
export function paperRunnerStopPrice(entryPrice: unknown, currentTrailingStop: unknown): number | null {
  const entry = finitePositive(entryPrice);
  const trailing = finitePositive(currentTrailingStop);
  if (entry == null || trailing == null) return null;
  return Math.max(entry, trailing);
}
