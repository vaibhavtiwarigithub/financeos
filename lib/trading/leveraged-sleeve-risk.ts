/** Shared SOXL+TQQQ+SQQQ+SOXS leveraged-sleeve NAV ceiling. Owner rule
 * (2026-09-23): "leveraged in total cannot be more than 5% of entire
 * portfolio ever" — combined across all four, not 5% per instrument.
 * Orthogonal to semiconductor-risk.ts's SOXL-specific 25%-of-NAV sector
 * concentration cap, which is unchanged. Widened 2026-09-23 to include
 * SQQQ/SOXS once the owner approved their paper (and, later, live) doors —
 * same combined ceiling, no separate inverse-only allowance.
 */
export const LEVERAGED_SLEEVE_MAX_NAV_FRACTION = 0.05;
// Paper entry policy v2: match the core constructor's 0.5%-NAV minimum
// viable position. A ceiling is not a mandate to spend the last fraction of a cent.
export const LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION = 0.005;
export type LeveragedEntrySizing = { nav: number; availableNotional: number; minimumNotional: number; shortfall: number };

/** Round UP so decimal serialization cannot turn an exact 2R plan into <2R. */
export function leveragedPriceTarget(entry: number, stop: number, atr: number, multiple: number, minRewardRisk = 0): number {
  const target = entry + Math.max(atr * multiple, (entry - stop) * minRewardRisk);
  return minRewardRisk > 0 ? Math.ceil(target * 1_000_000) / 1_000_000 : target;
}

export function leveragedPaperEntrySize(nav: number, availableNotional: number):
  { ok: true; maxNotional: number } | { ok: false; reason: string; sizing?: LeveragedEntrySizing } {
  if (!Number.isFinite(nav) || nav <= 0 || !Number.isFinite(availableNotional))
    return { ok: false, reason: "invalid_capacity" };
  const sizing = { nav, availableNotional, minimumNotional: nav * LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION,
    shortfall: Math.max(0, nav * LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION - availableNotional) };
  if (availableNotional <= 0) return { ok: false, reason: "no_capacity", sizing };
  if (availableNotional < nav * LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION)
    return { ok: false, reason: "below_minimum_entry", sizing };
  return { ok: true, maxNotional: availableNotional };
}
export const LEVERAGED_SLEEVE_SYMBOLS = new Set(["SOXL", "TQQQ", "SQQQ", "SOXS"]);

export interface LeveragedSleevePosition {
  symbol: string;
  marketValue: number;
}

/** Do not offset exact opposing daily-reset products and call it diversification. */
export function leveragedOpposingExposure(symbol: string, positions: LeveragedSleevePosition[]): { ok: true } | { ok: false; reason: string } {
  const opposite: Record<string, string> = { SOXL: "SOXS", SOXS: "SOXL", TQQQ: "SQQQ", SQQQ: "TQQQ" };
  if (!opposite[symbol]) return { ok: false, reason: "unknown_leveraged_symbol" };
  for (const p of positions) {
    if (!Number.isFinite(p.marketValue) || p.marketValue < 0) return { ok: false, reason: "invalid_position_mark" };
    if (p.symbol.toUpperCase() === opposite[symbol] && p.marketValue > 0) return { ok: false, reason: "opposing_leveraged_exposure" };
  }
  return { ok: true };
}

export function leveragedSleeveHeadroom(input: {
  nav: number;
  positions: LeveragedSleevePosition[];
}): { ok: true; headroom: number } | { ok: false; reason: string } {
  const { nav } = input;
  if (!Number.isFinite(nav) || nav <= 0) return { ok: false, reason: "invalid_nav" };
  let existing = 0;
  for (const p of input.positions) {
    if (!Number.isFinite(p.marketValue) || p.marketValue < 0) return { ok: false, reason: "invalid_position_mark" };
    if (LEVERAGED_SLEEVE_SYMBOLS.has(p.symbol.trim().toUpperCase())) existing += p.marketValue;
  }
  const headroom = Math.max(0, nav * LEVERAGED_SLEEVE_MAX_NAV_FRACTION - existing);
  return { ok: true, headroom };
}
