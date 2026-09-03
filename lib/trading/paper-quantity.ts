export type PaperQuantityMarket = "us" | "india";

const US_FRACTIONAL_SCALE = 1_000_000;

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
