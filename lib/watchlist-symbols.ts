const US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA"]);
const INDIA_EXCHANGE_SUFFIX: Record<string, ".NS" | ".BO"> = {
  NSE: ".NS",
  BSE: ".BO",
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function isPlausibleWatchlistSymbol(symbol: string): boolean {
  if (/^[A-Z0-9&-]{1,20}\.(NS|BO)$/.test(symbol)) return true;
  return /^[A-Z]{1,5}([.-][A-Z])?$/.test(symbol);
}

/** Normalize one TradingView token without rewriting malformed input into a ticker. */
export function normalizeWatchlistSymbol(value: string): string | null {
  const raw = unquote(value).toUpperCase();
  if (!raw) return null;

  const parts = raw.split(":");
  if (parts.length > 2) return null;

  let symbol = raw;
  if (parts.length === 2) {
    const [exchange, listedSymbol] = parts.map(part => part.trim());
    if (!exchange || !listedSymbol) return null;
    if (US_EXCHANGES.has(exchange)) {
      symbol = listedSymbol;
    } else if (exchange in INDIA_EXCHANGE_SUFFIX) {
      const suffix = INDIA_EXCHANGE_SUFFIX[exchange];
      symbol = /\.(NS|BO)$/.test(listedSymbol) ? listedSymbol : `${listedSymbol}${suffix}`;
    } else {
      return null;
    }
  }

  // Ampersand tickers are NSE-style names (for example M&M). A bare value must
  // gain the provider suffix or the watchlist API will classify it as US.
  if (parts.length === 1 && symbol.includes("&") && !/\.(NS|BO)$/.test(symbol)) {
    symbol = `${symbol}.NS`;
  }

  return isPlausibleWatchlistSymbol(symbol) ? symbol : null;
}

export function parseWatchlistCsvSymbols(text: string): string[] {
  const symbols = text
    .split(/[\n,\r]+/)
    .map(normalizeWatchlistSymbol)
    .filter((symbol): symbol is string => symbol !== null);
  return [...new Set(symbols)];
}
