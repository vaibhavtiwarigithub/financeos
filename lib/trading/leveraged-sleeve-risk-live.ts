/** Live-money counterpart to leveraged-sleeve-risk.ts. Same headroom math,
 * but against the owner-set fixed-dollar lease (strategy_config.
 * leveraged_sleeve_live_lease_usd) instead of 5% of paper NAV, and reading
 * open leveraged_live_positions rows instead of paper_positions. Paper and
 * live exposure are NEVER summed — this function only ever sees live rows.
 */
import { LEVERAGED_SLEEVE_SYMBOLS } from "./leveraged-sleeve-risk";

export interface LeveragedLivePosition {
  symbol: string;
  marketValue: number;
}

export function leveragedSleeveLiveHeadroom(input: {
  leaseUsd: number;
  positions: LeveragedLivePosition[];
}): { ok: true; headroom: number } | { ok: false; reason: string } {
  const { leaseUsd } = input;
  if (!Number.isFinite(leaseUsd) || leaseUsd <= 0) return { ok: false, reason: "no_lease_capacity" };
  let existing = 0;
  for (const p of input.positions) {
    if (!Number.isFinite(p.marketValue) || p.marketValue < 0) return { ok: false, reason: "invalid_position_mark" };
    if (LEVERAGED_SLEEVE_SYMBOLS.has(p.symbol.trim().toUpperCase())) existing += p.marketValue;
  }
  const headroom = Math.max(0, leaseUsd - existing);
  return { ok: true, headroom };
}
