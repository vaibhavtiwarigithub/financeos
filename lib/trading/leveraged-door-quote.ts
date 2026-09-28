// Executable quote for the leveraged-sleeve PAPER doors (SOXL/TQQQ/SQQQ/SOXS).
//
// The doors' planners require a finite bid and ask. Production quotes almost never
// carry them (Alpha Vantage has none; Massive's lastQuote needs an entitlement the
// account lacks), so `bid: quote.bid ?? NaN` made every entry fail `invalid_quote`
// and none of the four doors could ever open a position. The generic PaperTrader
// already models a paper fill as price plus a conservative adverse move
// (lib/data/quotes.ts computeEntryFillPrice); the doors now do the same, explicitly
// and only for paper: a REAL bid/ask is always preferred and still enforced against
// `maxSpreadBps`; when absent, a symmetric modeled spread around the fresh provider
// price is used and flagged `modeled` so the fill rationale says so. The modeled
// half-spread is deliberately wider than these ETFs' real spreads (~1-3 bps).
// Never used for a live order: the live door has its own kernel and requires a real quote.
export const MODELED_HALF_SPREAD_BPS = 10;

export interface DoorQuoteInput { bid: number | null; ask: number | null; price: number }
export interface DoorQuote { bid: number; ask: number; observedAt: number; modeled: boolean }

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** observedAt is the provider observation time (NaN when stale/unavailable) and is passed through, so freshness still fails closed. */
export function doorQuoteForPlan(quote: DoorQuoteInput, observedAt: number): DoorQuote {
  if (positive(quote.bid) && positive(quote.ask) && quote.ask >= quote.bid) {
    return { bid: quote.bid, ask: quote.ask, observedAt, modeled: false };
  }
  if (!positive(quote.price)) return { bid: Number.NaN, ask: Number.NaN, observedAt, modeled: true };
  const half = MODELED_HALF_SPREAD_BPS / 10_000;
  return { bid: quote.price * (1 - half), ask: quote.price * (1 + half), observedAt, modeled: true };
}

export function doorQuoteNote(quote: DoorQuote, source: string): string {
  return quote.modeled
    ? ` [quote modeled: +/-${MODELED_HALF_SPREAD_BPS}bps around ${source} price; no executable bid/ask]`
    : "";
}
