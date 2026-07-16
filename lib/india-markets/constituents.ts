// Versioned NIFTY-50 constituent snapshot for India market-breadth.
//
// Breadth must be computed against a KNOWN, dated index membership — not "today's
// list applied to history". `universeAsOf` stamps when this membership was
// effective so a future historical replay can pick the right snapshot instead of
// silently using current membership. Update BOTH the list and `universeAsOf`
// together whenever NSE reconstitutes the index.

import { NIFTY_50 } from "@/lib/india-universe";

export interface ConstituentUniverse {
  universeId: "nifty_50";
  universeAsOf: string; // YYYY-MM-DD — effective date of this membership snapshot
  symbols: string[];
}

export const NIFTY50_UNIVERSE: ConstituentUniverse = {
  universeId: "nifty_50",
  universeAsOf: "2026-07-01",
  symbols: NIFTY_50,
};

// Breadth is only labeled "complete" when at least this fraction of eligible
// constituents resolved a valid quote in the observation window. Below the floor
// the breadth block renders as an explicitly partial-coverage sample, never as a
// healthy-looking total.
export const BREADTH_COVERAGE_FLOOR = 0.8;
