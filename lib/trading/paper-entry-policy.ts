export const DEFAULT_MAX_ALPHA_NAMES_PER_MARKET = 10;

function normalizedSymbols(symbols: Iterable<string>): Set<string> {
  return new Set(Array.from(symbols, (symbol) => symbol.trim().toUpperCase()).filter(Boolean));
}

export function hasOpenPaperName(currentSymbols: Iterable<string>, candidateSymbol: string): boolean {
  const candidate = candidateSymbol.trim().toUpperCase();
  return !!candidate && normalizedSymbols(currentSymbols).has(candidate);
}

export function canOpenPaperName(
  currentSymbols: Iterable<string>,
  candidateSymbol: string,
  maxNames = DEFAULT_MAX_ALPHA_NAMES_PER_MARKET,
): boolean {
  const symbols = normalizedSymbols(currentSymbols);
  const candidate = candidateSymbol.trim().toUpperCase();
  if (!candidate) return false;
  const cap = Number.isInteger(maxNames) && maxNames > 0 ? maxNames : DEFAULT_MAX_ALPHA_NAMES_PER_MARKET;
  return !symbols.has(candidate) && symbols.size < cap;
}
