export interface ReviewedAdr {
  symbol: string;
  underlyingSymbol?: string;
  domicile: string;
  usExchange?: string;
  adsToOrdinaryShareRatio?: number;
}
// Reviewed US exchange-listed depositary receipts only. Membership is explicit:
// guessing from a suffix or provider profile can select the foreign underlying
// and mix per-share units with the USD ADS price.
const REVIEWED_ADRS: readonly ReviewedAdr[] = [
  ...[
    "INFY", "WIT", "HDB", "IBN", "RDY", "SIFY", "WNS", "MMYT", "VEDL", "AZRE",
  ].map((symbol) => ({ symbol, domicile: "India" })),
  ...[
    "BABA", "JD", "PDD", "BIDU", "NIO", "LI", "XPEV", "TCOM", "BILI", "TME",
  ].map((symbol) => ({ symbol, domicile: "China" })),
  ...[
    "TSM", "ASML", "SAP", "SHOP", "SE", "MELI", "NVO", "TM", "SONY", "UL",
  ].map((symbol) => ({ symbol, domicile: "Other" })),
  {
    symbol: "SKHY",
    underlyingSymbol: "000660.KS",
    domicile: "South Korea",
    usExchange: "NASDAQ",
    adsToOrdinaryShareRatio: 0.1,
  },
];

const REVIEWED_ADR_BY_SYMBOL = new Map(
  REVIEWED_ADRS.map((adr) => [adr.symbol, adr] as const),
);

// These identifiers must not be substituted for SKHY. SKHYV was temporary;
// HXSCL/HXSCF are OTC representations with different execution constraints.
export const UNSUPPORTED_ADR_PROXIES = new Set(["SKHYV", "HXSCL", "HXSCF"]);

export function reviewedAdr(symbol: string): ReviewedAdr | null {
  return REVIEWED_ADR_BY_SYMBOL.get(symbol.trim().toUpperCase()) ?? null;
}

export function isReviewedAdr(symbol: string): boolean {
  return reviewedAdr(symbol) !== null;
}

export function isUnsupportedAdrProxy(symbol: string): boolean {
  return UNSUPPORTED_ADR_PROXIES.has(symbol.trim().toUpperCase());
}
