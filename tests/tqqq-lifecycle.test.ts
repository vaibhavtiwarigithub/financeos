import { describe, expect, it } from "vitest";
import { planTqqqEntry, monitorTqqq } from "@/lib/trading/tqqq-lifecycle";

const entry = {
  policy: { version: "test-policy", maxQuoteAgeMs: 60000, maxSpreadBps: 30, maxMonitorAgeMs: 60000,
    atrStopMultiple: 2, maxStopPct: 15, targetAtrMultiple: 3, riskBudgetPct: 0.15 },
  now: 100000, quote: { bid: 99.9, ask: 100, observedAt: 99000 }, signalAt: 80000,
  lastExitAt: null, signalSession: "2026-09-21", expectedSignalSession: "2026-09-21",
  entryWindowOpen: true, monitorVerifiedAt: 99000, trendQualified: true,
  atr: 3, structuralStop: 95, nav: 10000, cash: 1000, leveragedSleevePositions: [],
};
const held = { market: "us" as const, qty: 10, avgEntry: 100, initialStopLoss: 94,
  currentStop: 94, highestPrice: 100, priceTarget: 109, partialTaken: false };
describe("TQQQ lifecycle contract", () => {
  it("binds volatility geometry to ask without inventing a reward floor", () => {
    expect(planTqqqEntry(entry)).toMatchObject({ ok: true, entry: 100, stop: 94, target: 109, maxNotional: 250 });
  });
  it("requires working monitoring and fresh quotes before entry", () => {
    expect(planTqqqEntry({ ...entry, monitorVerifiedAt: 0 })).toMatchObject({ ok: false, reason: "monitor_unhealthy" });
    expect(planTqqqEntry({ ...entry, quote: { ...entry.quote, observedAt: 100001 } })).toMatchObject({ ok: false, reason: "invalid_quote" });
  });
  it("prevents re-entry using the signal that preceded an exit", () => {
    expect(planTqqqEntry({ ...entry, lastExitAt: 90000 })).toMatchObject({ ok: false, reason: "fresh_signal_required_after_exit" });
  });
  it("rejects excessive stop risk rather than tightening to fit", () => {
    expect(planTqqqEntry({ ...entry, structuralStop: 70 })).toMatchObject({ ok: false, reason: "stop_risk_exceeded" });
  });
  it("clamps size to the shared SOXL+TQQQ sleeve headroom, not just its own cap", () => {
    // SOXL already holds 480 of the 500 (5% of 10000) sleeve ceiling -> only 20 headroom left.
    expect(planTqqqEntry({ ...entry, leveragedSleevePositions: [{ symbol: "SOXL", marketValue: 480 }] }))
      .toMatchObject({ ok: true, maxNotional: 20 });
  });
  it("denies entry when the sleeve is already full", () => {
    expect(planTqqqEntry({ ...entry, leveragedSleevePositions: [{ symbol: "SOXL", marketValue: 500 }] }))
      .toMatchObject({ ok: false, reason: "no_sleeve_capacity" });
  });
  it("evaluates exits from price + session low/high and takes protection before targets", () => {
    expect(monitorTqqq({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 100, dayLow: 90, dayHigh: 110, observedAt: 99000 }, position: held, thesisInvalidated: false }))
      .toMatchObject({ action: "stop_full", exitQty: 10 });
  });
  it("catches an intraday stop touch even when the current price has recovered above it", () => {
    expect(monitorTqqq({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 100, dayLow: 90, dayHigh: null, observedAt: 99000 }, position: held, thesisInvalidated: false }))
      .toMatchObject({ action: "stop_full" });
  });
  it("does not fabricate an exit when data is stale", () => {
    expect(monitorTqqq({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 90, dayLow: null, dayHigh: null, observedAt: 0 }, position: held, thesisInvalidated: true }))
      .toMatchObject({ action: "data_unavailable", blockNewEntries: true });
  });
  it("takes partial profit once and protects the remaining runner", () => {
    expect(monitorTqqq({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 105, dayLow: 100, dayHigh: 111, observedAt: 99000 }, position: held, thesisInvalidated: false }))
      .toMatchObject({ action: "partial_target", exitQty: 5 });
    expect(monitorTqqq({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 105, dayLow: 100, dayHigh: 111, observedAt: 99000 }, position: { ...held, qty: 5, partialTaken: true }, thesisInvalidated: false }))
      .toMatchObject({ action: "runner_hold" });
  });
});
