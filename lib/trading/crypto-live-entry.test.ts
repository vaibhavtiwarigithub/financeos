import { describe, expect, it } from "vitest";
import { planCryptoLiveEntry, cryptoLiveLeaseHeadroom } from "./crypto-live-entry";

const entry = {
  now: 100000,
  quote: { bid: 99.9, ask: 100, observedAt: 99000 },
  maxQuoteAgeMs: 60000, maxSpreadBps: 30,
  atrPct: 3, structuralStopPct: 5, riskBudgetPct: 1,
  atrStopMultiple: 2, minStopPct: 2, maxStopPct: 15,
  rewardRiskMultiple: 2, expectedRoundTripCostPct: 0.2, minNetRewardRisk: 1,
  leaseUsd: 50, existingLivePositions: [],
};

describe("cryptoLiveLeaseHeadroom", () => {
  it("fails closed on a zero lease", () => {
    expect(cryptoLiveLeaseHeadroom({ leaseUsd: 0, positions: [] })).toEqual({ ok: false, reason: "no_lease_capacity" });
  });
  it("subtracts all existing crypto live positions combined", () => {
    expect(cryptoLiveLeaseHeadroom({ leaseUsd: 50, positions: [{ symbol: "BTC", marketValue: 30 }] })).toEqual({ ok: true, headroom: 20 });
  });
  it("floors at zero", () => {
    expect(cryptoLiveLeaseHeadroom({ leaseUsd: 50, positions: [{ symbol: "BTC", marketValue: 60 }] })).toEqual({ ok: true, headroom: 0 });
  });
});

describe("planCryptoLiveEntry", () => {
  it("produces a valid plan sized to the lease headroom", () => {
    const plan = planCryptoLiveEntry(entry);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.entry).toBe(100);
      expect(plan.maxNotional).toBeGreaterThan(0);
      expect(plan.maxNotional).toBeLessThanOrEqual(50);
      expect(plan.stop).toBeLessThan(plan.entry);
      expect(plan.target).toBeGreaterThan(plan.entry);
    }
  });
  it("rejects a stale or invalid quote", () => {
    expect(planCryptoLiveEntry({ ...entry, quote: { ...entry.quote, observedAt: 100001 } })).toMatchObject({ ok: false, reason: "invalid_quote" });
  });
  it("rejects an excessive spread", () => {
    expect(planCryptoLiveEntry({ ...entry, quote: { bid: 90, ask: 100, observedAt: 99000 } })).toMatchObject({ ok: false, reason: "spread_exceeded" });
  });
  it("refuses without lease capacity", () => {
    expect(planCryptoLiveEntry({ ...entry, leaseUsd: 0 })).toMatchObject({ ok: false, reason: "no_lease_capacity" });
  });
  it("denies entry when the lease is already fully deployed", () => {
    expect(planCryptoLiveEntry({ ...entry, existingLivePositions: [{ symbol: "ETH", marketValue: 50 }] })).toMatchObject({ ok: false, reason: "no_sleeve_capacity" });
  });
});
