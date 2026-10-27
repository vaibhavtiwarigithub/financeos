type PrewarmResult = {
  failed: number;
  skipped: number;
  failedSymbols?: string[];
  skippedSymbols?: string[];
};

/** Keep health alerts actionable without copying provider exception details. */
export function formatPrewarmFailureSymbols(result: PrewarmResult, limit = 12): string {
  const failures = (result.failedSymbols ?? [])
    .filter(isSafeSymbol)
    .map((symbol) => `failed:${symbol.toUpperCase()}`);
  const deferred = (result.skippedSymbols ?? [])
    .filter(isSafeSymbol)
    .map((symbol) => `deferred:${symbol.toUpperCase()}`);
  const names = [...failures, ...deferred];
  const expected = result.failed + result.skipped;

  if (names.length === 0) {
    return expected > 0
      ? `Unrefreshed symbol identities unavailable (${expected} affected).`
      : "No unrefreshed symbols.";
  }

  const shown = names.slice(0, Math.max(0, limit));
  const omitted = Math.max(0, expected - shown.length);
  return `Unrefreshed symbols: ${shown.join(", ")}${omitted > 0 ? `; ${omitted} more omitted` : ""}.`;
}

function isSafeSymbol(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9.^-]{0,19}$/i.test(value);
}
