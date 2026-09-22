// Pure math for the market-breadth shadow: what fraction of a constituent
// universe trades above its own 50-session simple moving average. This is the
// S5FI-style metric (owner-requested 2026-09-22) — distinct from the existing
// sector_breadth_history (daily advance/decline, mostly dead: XLF stale since
// 2026-07-21, XLK the only one still fed) and from India's existing NIFTY-50
// advance/decline block in lib/india-markets/snapshot.ts. Neither of those
// computes a moving-average breadth; this module does, for both markets.
import type { Candle } from "@/lib/data/technicals";

export interface BreadthResult {
  pctAboveSma50: number | null;
  eligible: number;   // constituents with enough history to evaluate
  resolved: number;   // of those, how many are above their own SMA50
  universeSize: number;
  coveragePct: number; // eligible / universeSize -- low coverage means don't trust pctAboveSma50
}

function sma50(candles: Candle[]): number | null {
  const closes = candles.filter(c => Number.isFinite(c.close) && c.close > 0).map(c => c.close);
  if (closes.length < 50) return null;
  const window = closes.slice(-50);
  return window.reduce((a, b) => a + b, 0) / 50;
}

/** perSymbolCandles: symbol -> its own daily candles, oldest-first. */
export function computeBreadthAboveSma50(perSymbolCandles: Map<string, Candle[]>): BreadthResult {
  const universeSize = perSymbolCandles.size;
  let eligible = 0;
  let resolved = 0;
  for (const candles of perSymbolCandles.values()) {
    const avg = sma50(candles);
    if (avg == null) continue;
    const last = candles.filter(c => Number.isFinite(c.close) && c.close > 0).at(-1);
    if (!last) continue;
    eligible += 1;
    if (last.close > avg) resolved += 1;
  }
  return {
    pctAboveSma50: eligible > 0 ? (resolved / eligible) * 100 : null,
    eligible, resolved, universeSize,
    coveragePct: universeSize > 0 ? (eligible / universeSize) * 100 : 0,
  };
}
