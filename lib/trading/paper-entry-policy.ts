export const DEFAULT_MAX_ALPHA_NAMES_PER_MARKET = 10;

export function canOpenPaperName(
  currentSymbols: Iterable<string>,
  candidateSymbol: string,
  maxNames = DEFAULT_MAX_ALPHA_NAMES_PER_MARKET,
): boolean {
  const symbols = new Set(Array.from(currentSymbols, (s) => s.trim().toUpperCase()).filter(Boolean));
  const candidate = candidateSymbol.trim().toUpperCase();
  if (!candidate) return false;
  const cap = Number.isInteger(maxNames) && maxNames > 0 ? maxNames : DEFAULT_MAX_ALPHA_NAMES_PER_MARKET;
  return symbols.has(candidate) || symbols.size < cap;
}
