const IGNORE_TICKERS = new Set([
  "A", "I", "AM", "AN", "AS", "AT", "BE", "BY", "DO", "IF", "IN", "IS", "IT", "ME", "MY", "NO", "OF", "ON", "OR", "SO", "TO", "UP", "US", "WE",
  "AND", "ARE", "BUT", "CAN", "FOR", "HAD", "HAS", "HIM", "HIS", "HOW", "ITS", "LET", "MAY", "NEW", "NOT", "NOW", "ONE", "OUR", "OUT", "PUT",
  "THE", "TOO", "WAS", "WHO", "WHY", "YET", "YOU", "ALL", "ANY", "FEW", "OLD", "OWN", "PER", "SAW", "SEE", "SET", "SHE", "TOP", "TWO", "USE",
  "VIA", "WAY", "YTD", "ETF", "CEO", "CFO", "GDP", "IPO", "LTM", "NTM", "P&L", "YOY", "QOQ", "ROE", "ROI", "EPS", "FCF", "NAV",
  "OPEN", "RISK", "HIGH", "LOW", "MUCH", "NEXT", "ONLY", "OVER", "PAST", "REAL", "SAME", "SHOW", "STAY", "TAKE", "THAN", "THAT", "THEM",
  "THEN", "THEY", "THIS", "THUS", "TOLD", "UPON", "VERY", "WELL", "WHEN", "WITH", "YEAR", "YOUR", "BOND", "CASH", "DEBT", "HOLD",
  "LONG", "SELL", "STOP", "BUY", "WAIT", "WEEK", "DAYS", "LAST", "BOTH", "BEST", "NEAR", "MOST", "MORE", "LESS", "INTO",
  "NYSE", "NASDAQ", "POST", "PRE", "RATE", "PLAN", "WANT", "SAID", "WILL", "JUST", "ALSO", "FROM", "BEEN", "HAVE", "WERE", "EACH",
  "SOME", "LIKE", "WHAT", "EVEN", "BACK", "LOOK", "MAKE", "GOOD", "MANY", "COME", "CALL", "KNOW", "GIVE", "MOVE",
  "USD", "INR", "RBI", "FII", "DII", "NSE", "BSE", "NIFTY", "SENSEX", "SEBI", "MSCI", "GST", "FED", "ECB", "BOJ", "PMI", "WPI",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract explicit ticker-like tokens without treating long all-caps prose as symbols. */
export function extractBriefingTickers(text: string, knownSymbols: Iterable<string> = []): string[] {
  const candidates: string[] = text.match(/(?<![A-Za-z])(?:\$[A-Z]{2,10}|[A-Z]{2,5})(?![A-Za-z])/g) ?? [];

  // Longer unprefixed symbols are accepted only when they are already known to Kairos.
  for (const rawSymbol of knownSymbols) {
    const symbol = rawSymbol.trim().toUpperCase();
    if (symbol.length <= 5 || symbol.length > 10 || !/^[A-Z]+$/.test(symbol)) continue;
    if (new RegExp(`(?<![A-Za-z])${escapeRegExp(symbol)}(?![A-Za-z])`).test(text)) candidates.push(symbol);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const symbol = candidate.replace(/^\$/, "");
    if (!IGNORE_TICKERS.has(symbol) && !seen.has(symbol)) {
      seen.add(symbol);
      result.push(symbol);
    }
  }
  return result.slice(0, 10);
}
