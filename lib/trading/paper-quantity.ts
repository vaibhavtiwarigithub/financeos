export type PaperQuantityMarket = "us" | "india";

const US_FRACTIONAL_SCALE = 1_000_000;

function finitePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
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
