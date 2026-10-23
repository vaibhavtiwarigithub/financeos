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

export function leveragedPaperEntrySize(nav: number, availableNotional: number):
  { ok: true; maxNotional: number } | { ok: false; reason: string } {
  if (!Number.isFinite(nav) || nav <= 0 || !Number.isFinite(availableNotional))
    return { ok: false, reason: "invalid_capacity" };
  if (availableNotional <= 0) return { ok: false, reason: "no_capacity" };
  if (availableNotional < nav * LEVERAGED_PAPER_MIN_ENTRY_NAV_FRACTION)
    return { ok: false, reason: "below_minimum_entry" };
  return { ok: true, maxNotional: availableNotional };
}
export const LEVERAGED_SLEEVE_SYMBOLS = new Set(["SOXL", "TQQQ", "SQQQ", "SOXS"]);

export interface LeveragedSleevePosition {
  symbol: string;
  marketValue: number;
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
