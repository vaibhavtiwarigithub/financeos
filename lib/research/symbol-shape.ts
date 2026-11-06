// Shape check for SCREENER-DISCOVERED US symbols (never applied to holdings, the owner watchlist, crypto or India).
//
// 2026-11-04: `screener_momentum` admitted `IXAZ6`, a futures-contract-style code that Yahoo answers "Not Found". It could not be priced, so every
// price prewarm failed on it and raised a standing warn until it was hand-disabled. US exchange tickers are 1-5 letters with an optional class
// suffix ("BRK.B", "BF-B"); a digit never appears. Rejecting the shape at admission stops the symbol costing research budget and alert noise.
const US_EQUITY_SHAPE = /^[A-Z]{1,5}([.-][A-Z]{1,2})?$/;

export function isPlausibleDiscoveredUsSymbol(symbol: string): boolean {
  return US_EQUITY_SHAPE.test(String(symbol ?? "").trim().toUpperCase());
}
