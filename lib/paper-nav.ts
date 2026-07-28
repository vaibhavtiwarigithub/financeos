// Per-market paper starting NAV — the baseline an equity curve's return % is
// measured against. NEVER measure a ₹ NAV against the US 10,000 seed: India's
// paper book seeds at ₹10,00,000, so a ₹9.8L NAV against 10,000 renders as
// +9,700% instead of -2%.
//
// This mirrors START_NAV in lib/kill-switches.ts. That copy guards the paper/live
// trade path and is deliberately NOT touched by display-only changes; if the seeds
// ever change, change both. Display surfaces should import from here.

import type { Mkt } from "@/lib/format-money";

export const PAPER_START_NAV: Record<Mkt, number> = { us: 10_000, india: 1_000_000 };

/** Paper seed NAV for a market, defaulting to the US book for unknown values. */
export function paperStartNav(market: Mkt): number {
  return PAPER_START_NAV[market] ?? PAPER_START_NAV.us;
}

/** Return % of a NAV point vs its own market's seed. Never cross-market. */
export function navReturnPct(nav: number, market: Mkt): number {
  const seed = paperStartNav(market);
  return +(((nav - seed) / seed) * 100).toFixed(2);
}

export interface PaperPerformanceTruthInput {
  market: Mkt;
  nav: number;
  previousNav: number | null;
  benchReturnPct: number | null;
  winCount: number;
  lossCount: number;
  resolvedTradeCount: number;
}

/** Count only terminal, classified outcomes; NULL/unknown is not breakeven. */
export function resolvedPaperOutcomeCount(
  outcomes: Array<{ outcome: string | null }>,
): number {
  return outcomes.filter(({ outcome }) =>
    outcome === "win" || outcome === "loss" || outcome === "breakeven"
  ).length;
}

/** Canonical derived fields shared by every writer of paper_performance. */
export function paperPerformanceTruth(input: PaperPerformanceTruthInput) {
  const seed = paperStartNav(input.market);
  const totalPnl = input.nav - seed;
  const totalPnlPct = seed > 0 ? (totalPnl / seed) * 100 : 0;
  const dailyPnl = input.previousNav == null ? 0 : input.nav - input.previousNav;
  const winRate = input.resolvedTradeCount > 0
    ? input.winCount / input.resolvedTradeCount
    : 0;

  return {
    daily_pnl: dailyPnl,
    total_pnl: totalPnl,
    total_pnl_pct: totalPnlPct,
    win_count: input.winCount,
    loss_count: input.lossCount,
    win_rate: winRate,
    alpha_pct: input.benchReturnPct == null ? null : totalPnlPct - input.benchReturnPct,
  };
}
