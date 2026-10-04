import { describe, expect, it } from "vitest";
import { doorQuoteForPlan, MODELED_HALF_SPREAD_BPS } from "@/lib/trading/leveraged-door-quote";
import { planSoxlEntry, type SoxlPolicy } from "@/lib/trading/soxl-lifecycle";

describe("leveraged door quote", () => {
  it("prefers a real bid/ask and marks it unmodeled", () => {
    const q = doorQuoteForPlan({ bid: 99.9, ask: 100.1, price: 100 }, 123);
    expect(q).toEqual({ bid: 99.9, ask: 100.1, observedAt: 123, modeled: false });
  });
  it("models a symmetric conservative spread when the provider has no bid/ask", () => {
    const q = doorQuoteForPlan({ bid: null, ask: null, price: 100 }, 5);
    expect(q.modeled).toBe(true);
    expect(q.ask).toBeCloseTo(100 * (1 + MODELED_HALF_SPREAD_BPS / 10_000), 10);
    expect(q.bid).toBeCloseTo(100 * (1 - MODELED_HALF_SPREAD_BPS / 10_000), 10);
  });
  it("does not trust a crossed or non-positive real quote; it falls back to the price model", () => {
    expect(doorQuoteForPlan({ bid: 101, ask: 100, price: 100 }, 1).modeled).toBe(true);
    expect(doorQuoteForPlan({ bid: 0, ask: 100, price: 100 }, 1).modeled).toBe(true);
  });
  it("fails closed with NaN when there is no usable price at all, and preserves stale (NaN) observation time", () => {
    const q = doorQuoteForPlan({ bid: null, ask: null, price: 0 }, Number.NaN);
    expect(Number.isNaN(q.bid) && Number.isNaN(q.ask) && Number.isNaN(q.observedAt)).toBe(true);
  });
});

describe("planner accepts the modeled quote (regression: every door failed invalid_quote before)", () => {
  const policy: SoxlPolicy = { version: "v", maxQuoteAgeMs: 1800000, maxSpreadBps: 50, maxMonitorAgeMs: 86400000,
    atrStopMultiple: 2, maxStopPct: 12, targetAtrMultiple: 3, riskBudgetPct: 1, semiconductorCapPct: 25 };
  const now = Date.UTC(2026, 8, 29, 15, 5);
  const base = (quote: any) => planSoxlEntry({ policy, now, quote, signalAt: now - 3600_000, lastExitAt: null,
    signalSession: "2026-09-28", expectedSignalSession: "2026-09-28", entryWindowOpen: true, monitorVerifiedAt: now - 3600_000,
    trendQualified: true, atr: 2, structuralStop: 90, nav: 10000, cash: 5000, holdings: [], leveragedSleevePositions: [] });
  it("old wiring (NaN bid/ask) is refused; modeled quote is planned", () => {
    expect(base({ bid: NaN, ask: NaN, observedAt: now })).toEqual({ ok: false, reason: "invalid_quote" });
    const plan = base(doorQuoteForPlan({ bid: null, ask: null, price: 100 }, now));
    expect(plan.ok).toBe(true);
  });
  it("a real wide spread is still refused", () => {
    expect(base(doorQuoteForPlan({ bid: 99, ask: 101, price: 100 }, now))).toEqual({ ok: false, reason: "spread_exceeded" });
  });
});
