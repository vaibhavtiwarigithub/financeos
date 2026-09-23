import { computeCryptoGeometry, type CryptoGeometryInput } from "./crypto-exit-geometry";

/** Live-money entry planner for crypto (BTC/ETH/SOL). Reuses the existing,
 * already-tested computeCryptoGeometry (paper's own geometry function)
 * unchanged for stop/target math, but sizes against the crypto live lease
 * headroom instead of paper NAV -- same "nav" parameter, reinterpreted, with
 * maxNotionalPct=100 since the lease itself IS the ceiling, not a % of a
 * larger book. Quote-freshness and account-eligibility checks mirror the
 * leveraged-sleeve live entry planner's own discipline.
 */
export interface CryptoLivePosition { symbol: string; marketValue: number }

export function cryptoLiveLeaseHeadroom(input: { leaseUsd: number; positions: CryptoLivePosition[] }): { ok: true; headroom: number } | { ok: false; reason: string } {
  const { leaseUsd } = input;
  if (!Number.isFinite(leaseUsd) || leaseUsd <= 0) return { ok: false, reason: "no_lease_capacity" };
  let existing = 0;
  for (const p of input.positions) {
    if (!Number.isFinite(p.marketValue) || p.marketValue < 0) return { ok: false, reason: "invalid_position_mark" };
    existing += p.marketValue;
  }
  return { ok: true, headroom: Math.max(0, leaseUsd - existing) };
}

export interface CryptoLiveQuote { bid: number; ask: number; observedAt: number }

function fresh(time: number, now: number, maxAge: number): boolean {
  return Number.isFinite(time) && Number.isFinite(now) && time <= now && now - time <= maxAge;
}

export function planCryptoLiveEntry(input: {
  now: number;
  quote: CryptoLiveQuote;
  maxQuoteAgeMs: number;
  maxSpreadBps: number;
  atrPct: number;
  structuralStopPct: number;
  riskBudgetPct: number;
  atrStopMultiple: number;
  minStopPct: number;
  maxStopPct: number;
  rewardRiskMultiple: number;
  expectedRoundTripCostPct: number;
  minNetRewardRisk: number;
  leaseUsd: number;
  existingLivePositions: CryptoLivePosition[];
}): { ok: false; reason: string } | { ok: true; entry: number; stop: number; target: number; maxNotional: number } {
  const q = input.quote;
  if (![q.bid, q.ask].every(v => Number.isFinite(v) && v > 0) || q.ask < q.bid
    || !fresh(q.observedAt, input.now, input.maxQuoteAgeMs)) return { ok: false, reason: "invalid_quote" };
  if ((q.ask - q.bid) / q.bid * 10000 > input.maxSpreadBps) return { ok: false, reason: "spread_exceeded" };

  const headroom = cryptoLiveLeaseHeadroom({ leaseUsd: input.leaseUsd, positions: input.existingLivePositions });
  if (!headroom.ok) return headroom;
  if (headroom.headroom <= 0) return { ok: false, reason: "no_sleeve_capacity" };

  const geometryInput: CryptoGeometryInput = {
    entryPrice: q.ask, atrPct: input.atrPct, structuralStopPct: input.structuralStopPct,
    riskBudgetPct: input.riskBudgetPct, nav: headroom.headroom, maxNotionalPct: 100,
    atrStopMultiple: input.atrStopMultiple, minStopPct: input.minStopPct, maxStopPct: input.maxStopPct,
    rewardRiskMultiple: input.rewardRiskMultiple, expectedRoundTripCostPct: input.expectedRoundTripCostPct,
    minNetRewardRisk: input.minNetRewardRisk,
  };
  const geometry = computeCryptoGeometry(geometryInput);
  if (!geometry.ok) return { ok: false, reason: geometry.reason };

  return { ok: true, entry: q.ask, stop: geometry.stopLoss, target: geometry.priceTarget, maxNotional: geometry.proposedNotional };
}
