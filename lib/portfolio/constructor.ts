// Portfolio Constructor — deterministic, pure, unit-tested cross-position risk
// budgeting. Signals are sized independently upstream (flat % today, Kelly in
// Phase 2); this layer looks at the WHOLE BOOK and shrinks/denies candidate
// sizes so the post-trade portfolio never breaches name/sector/gross/vol/
// correlation limits. Never increases a size, never force-sells the book —
// only ever trims what's ABOUT to be added.
//
// Fixed rule order (do not reorder): name cap -> sector cap -> gross cap ->
// vol budget -> correlation penalty. Each rule only shrinks what earlier rules
// left; the audit trail records every adjustment made.

// NOTE on units: all *Pct fields here are PERCENTAGE POINTS on a 0-100 scale
// (matches strategy_config.position_size_pct convention elsewhere in the app —
// 10 means 10%, not 0.10). Only dailyVol is a fraction (0.02 = 2%/day).
export interface CandidateOrder {
  symbol: string;
  market: "us" | "india";
  proposedSizePct: number; // 0-100, e.g. 10 = 10% of pool cash
  sector: string | null;
  beta: number | null;
  dailyVol: number | null; // 20d stdev of daily returns, e.g. 0.02 = 2%/day
}

export interface BookPosition {
  symbol: string;
  sector: string | null;
  valuePct: number; // 0-100, % of pool NAV currently held
  beta: number | null;
  dailyVol: number | null;
}

export interface PortfolioLimits {
  maxGrossExposurePct: number;   // default 80
  maxSectorExposurePct: number;  // default 30
  maxNameExposurePct: number;    // default 12
  maxPortfolioVolPct: number;    // default 2.0 (daily, %)
  maxAvgPairwiseCorr: number;    // default 0.7 (informational bound; not solved for directly — see corr penalty)
}

export const DEFAULT_LIMITS: PortfolioLimits = {
  maxGrossExposurePct: 80,
  maxSectorExposurePct: 30,
  maxNameExposurePct: 12,
  maxPortfolioVolPct: 2.0,
  maxAvgPairwiseCorr: 0.7,
};

export interface SizedOrder extends CandidateOrder {
  finalSizePct: number;
  adjustments: string[];
}

export interface ConstructResult {
  orders: SizedOrder[];
  bookAfter: { grossPct: number; estDailyVolPct: number };
}

const UNKNOWN_SECTOR = "UNKNOWN";
const CORR_SAME_SECTOR = 0.6;
const CORR_CROSS_SECTOR = 0.3;
const STACK_HAIRCUT = 0.7; // multiply size by this when a sector already holds >=2 positions

function assertSingleMarket(book: BookPosition[], candidates: CandidateOrder[]): void {
  const markets = new Set([...candidates.map(c => c.market)]);
  if (markets.size > 1) {
    throw new Error(`constructPortfolio: mixed markets in one call (${[...markets].join(",")}) — currencies must never be mixed in one book`);
  }
}

function sectorOf(s: string | null): string {
  return s && s.length > 0 ? s : UNKNOWN_SECTOR;
}

export function constructPortfolio(
  book: BookPosition[],
  candidates: CandidateOrder[],
  limits: PortfolioLimits = DEFAULT_LIMITS
): ConstructResult {
  assertSingleMarket(book, candidates);

  const orders: SizedOrder[] = candidates.map(c => ({ ...c, finalSizePct: c.proposedSizePct, adjustments: [] }));

  // ── Rule 1: name cap — candidate size can't push the SAME symbol's total
  // exposure (existing book position + this candidate) past maxNameExposurePct.
  for (const o of orders) {
    const existing = book.find(b => b.symbol === o.symbol)?.valuePct ?? 0;
    const room = Math.max(0, limits.maxNameExposurePct - existing);
    if (o.finalSizePct > room) {
      o.adjustments.push(`name_cap: ${o.finalSizePct.toFixed(2)}% -> ${room.toFixed(2)}% (existing ${existing.toFixed(2)}%, cap ${limits.maxNameExposurePct}%)`);
      o.finalSizePct = room;
    }
  }

  // ── Rule 2: sector cap — proportionally scale candidates in each sector so
  // (existing sector exposure + this round's candidates) <= maxSectorExposurePct.
  // Unknown sector rolls into a synthetic "UNKNOWN" bucket with the same cap.
  const sectorsInPlay = new Set([...book.map(b => sectorOf(b.sector)), ...orders.map(o => sectorOf(o.sector))]);
  for (const sector of sectorsInPlay) {
    const existingSectorPct = book.filter(b => sectorOf(b.sector) === sector).reduce((s, b) => s + b.valuePct, 0);
    const sectorOrders = orders.filter(o => sectorOf(o.sector) === sector && o.finalSizePct > 0);
    const candidateSectorPct = sectorOrders.reduce((s, o) => s + o.finalSizePct, 0);
    const total = existingSectorPct + candidateSectorPct;
    if (total > limits.maxSectorExposurePct && candidateSectorPct > 0) {
      const allowedForCandidates = Math.max(0, limits.maxSectorExposurePct - existingSectorPct);
      const scale = allowedForCandidates / candidateSectorPct;
      for (const o of sectorOrders) {
        const before = o.finalSizePct;
        o.finalSizePct = o.finalSizePct * scale;
        o.adjustments.push(`sector_cap(${sector}): ${before.toFixed(2)}% -> ${o.finalSizePct.toFixed(2)}% (sector total would be ${total.toFixed(2)}%, cap ${limits.maxSectorExposurePct}%)`);
      }
    }
  }

  // ── Rule 3: gross cap — proportional scale-down of ALL candidates so total
  // book+candidates gross exposure <= maxGrossExposurePct.
  const existingGross = book.reduce((s, b) => s + b.valuePct, 0);
  const candidateGross = orders.reduce((s, o) => s + o.finalSizePct, 0);
  if (existingGross + candidateGross > limits.maxGrossExposurePct && candidateGross > 0) {
    const allowedForCandidates = Math.max(0, limits.maxGrossExposurePct - existingGross);
    const scale = allowedForCandidates / candidateGross;
    for (const o of orders) {
      if (o.finalSizePct <= 0) continue;
      const before = o.finalSizePct;
      o.finalSizePct = o.finalSizePct * scale;
      o.adjustments.push(`gross_cap: ${before.toFixed(2)}% -> ${o.finalSizePct.toFixed(2)}% (book+candidates would be ${(existingGross + candidateGross).toFixed(2)}%, cap ${limits.maxGrossExposurePct}%)`);
    }
  }

  // ── Rule 4: vol budget — estimate portfolio daily vol (book + scaled
  // candidates) via a simple variance model with an assumed pairwise
  // correlation (higher within the same sector). If over budget, scale down
  // CANDIDATES ONLY (never the existing book) proportionally.
  function estPortfolioVol(weights: { pct: number; vol: number; sector: string }[]): number {
    let variance = 0;
    for (let i = 0; i < weights.length; i++) {
      const wi = weights[i].pct / 100, voli = weights[i].vol;
      variance += wi * wi * voli * voli;
      for (let j = i + 1; j < weights.length; j++) {
        const wj = weights[j].pct / 100, volj = weights[j].vol;
        const corr = weights[i].sector === weights[j].sector ? CORR_SAME_SECTOR : CORR_CROSS_SECTOR;
        variance += 2 * corr * wi * voli * wj * volj;
      }
    }
    return Math.sqrt(Math.max(0, variance)) * 100; // back to % units
  }

  const bookWeights = book.map(b => ({ pct: b.valuePct, vol: b.dailyVol ?? 0.02, sector: sectorOf(b.sector) }));
  let candidateWeights = orders.filter(o => o.finalSizePct > 0).map(o => ({ pct: o.finalSizePct, vol: o.dailyVol ?? 0.02, sector: sectorOf(o.sector) }));

  let estVol = estPortfolioVol([...bookWeights, ...candidateWeights]);
  if (estVol > limits.maxPortfolioVolPct && candidateWeights.length > 0) {
    // Binary-search a single scale factor for all candidates that brings the
    // estimate back within budget (variance is quadratic in scale for the
    // candidate-only terms in a simple bisection — good enough for a risk cap).
    let lo = 0, hi = 1, scale = 1;
    for (let iter = 0; iter < 30; iter++) {
      scale = (lo + hi) / 2;
      const scaled = candidateWeights.map(c => ({ ...c, pct: c.pct * scale }));
      const v = estPortfolioVol([...bookWeights, ...scaled]);
      if (v > limits.maxPortfolioVolPct) hi = scale; else lo = scale;
    }
    for (const o of orders) {
      if (o.finalSizePct <= 0) continue;
      const before = o.finalSizePct;
      o.finalSizePct = o.finalSizePct * scale;
      o.adjustments.push(`vol_budget: ${before.toFixed(2)}% -> ${o.finalSizePct.toFixed(2)}% (est portfolio vol ${estVol.toFixed(2)}% > cap ${limits.maxPortfolioVolPct}%)`);
    }
    candidateWeights = orders.filter(o => o.finalSizePct > 0).map(o => ({ pct: o.finalSizePct, vol: o.dailyVol ?? 0.02, sector: sectorOf(o.sector) }));
    estVol = estPortfolioVol([...bookWeights, ...candidateWeights]);
  }

  // ── Rule 5: correlation / stacked-bet haircut — if a candidate's sector
  // already holds >= 2 positions (book + already-accepted candidates in this
  // batch), multiply its size by STACK_HAIRCUT.
  const sectorCounts: Record<string, number> = {};
  for (const b of book) sectorCounts[sectorOf(b.sector)] = (sectorCounts[sectorOf(b.sector)] ?? 0) + 1;
  for (const o of orders) {
    if (o.finalSizePct <= 0) continue;
    const sector = sectorOf(o.sector);
    if ((sectorCounts[sector] ?? 0) >= 2) {
      const before = o.finalSizePct;
      o.finalSizePct = o.finalSizePct * STACK_HAIRCUT;
      o.adjustments.push(`stacked_bet(${sector}): ${before.toFixed(2)}% -> ${o.finalSizePct.toFixed(2)}% (sector already holds ${sectorCounts[sector]} positions)`);
    }
    sectorCounts[sector] = (sectorCounts[sector] ?? 0) + 1;
  }

  // Floor: deny (zero out) sizes that got scaled below a token minimum.
  const MIN_VIABLE_PCT = 0.5;
  for (const o of orders) {
    if (o.finalSizePct > 0 && o.finalSizePct < MIN_VIABLE_PCT) {
      o.adjustments.push(`denied: scaled size ${o.finalSizePct.toFixed(3)}% below minimum viable ${MIN_VIABLE_PCT}%`);
      o.finalSizePct = 0;
    }
  }

  const finalGross = existingGross + orders.reduce((s, o) => s + o.finalSizePct, 0);
  const finalCandWeights = orders.filter(o => o.finalSizePct > 0).map(o => ({ pct: o.finalSizePct, vol: o.dailyVol ?? 0.02, sector: sectorOf(o.sector) }));
  const finalVol = estPortfolioVol([...bookWeights, ...finalCandWeights]);

  return { orders, bookAfter: { grossPct: finalGross, estDailyVolPct: finalVol } };
}
