import { CRYPTO_SYMBOLS } from "./instrument-taxonomy";

type Pair = { symbol: string; brokerPair: string; tradeable: boolean };

// Public paper research must cover its executable basket even when the broker
// returns a partial inventory. Missing broker membership never implies live eligibility.
export function cryptoResearchInventory(pairs: Pair[]): Pair[] {
  const inventory = new Map<string, Pair>();
  for (const pair of pairs) {
    const base = pair.symbol.toUpperCase().replace(/[-/]USD$/, "");
    if (!/^[A-Z0-9]+$/.test(base)) continue;
    const symbol = `${base}-USD`;
    inventory.set(symbol, { ...pair, symbol });
  }
  for (const symbol of CRYPTO_SYMBOLS) {
    if (!inventory.has(symbol)) inventory.set(symbol, { symbol, brokerPair: symbol, tradeable: false });
  }
  return [...inventory.values()].sort((a, b) =>
    Number(CRYPTO_SYMBOLS.has(b.symbol)) - Number(CRYPTO_SYMBOLS.has(a.symbol)) || a.symbol.localeCompare(b.symbol));
}
