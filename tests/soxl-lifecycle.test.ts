import { describe, expect, it } from "vitest";
import { planSoxlEntry, monitorSoxl } from "@/lib/trading/soxl-lifecycle";

const entry = {
  policy: { version: "test-policy", maxQuoteAgeMs: 60000, maxSpreadBps: 30, maxMonitorAgeMs: 60000,
    atrStopMultiple: 2, maxStopPct: 15, targetAtrMultiple: 3, riskBudgetPct: 0.15, semiconductorCapPct: 20 },
  now: 100000, quote: { bid: 99.9, ask: 100, observedAt: 99000 }, signalAt: 80000,
  lastExitAt: null, signalSession: "2026-09-21", expectedSignalSession: "2026-09-21",
  entryWindowOpen: true, monitorVerifiedAt: 99000, trendQualified: true,
  atr: 3, structuralStop: 95, nav: 10000, cash: 1000, holdings: [],
};
const held = { market: "us" as const, qty: 10, avgEntry: 100, initialStopLoss: 94,
  currentStop: 94, highestPrice: 100, priceTarget: 109, partialTaken: false };
describe("SOXL lifecycle contract", () => {
  it("binds volatility geometry to ask without inventing a reward floor", () => {
    expect(planSoxlEntry(entry)).toMatchObject({ ok: true, entry: 100, stop: 94, target: 109, maxNotional: 250 });
  });
  it("requires working monitoring and fresh quotes before entry", () => {
    expect(planSoxlEntry({ ...entry, monitorVerifiedAt: 0 })).toMatchObject({ ok: false, reason: "monitor_unhealthy" });
    expect(planSoxlEntry({ ...entry, quote: { ...entry.quote, observedAt: 100001 } })).toMatchObject({ ok: false, reason: "invalid_quote" });
  });
  it("prevents re-entry using the signal that preceded an exit", () => {
    expect(planSoxlEntry({ ...entry, lastExitAt: 90000 })).toMatchObject({ ok: false, reason: "fresh_signal_required_after_exit" });
  });
  it("rejects excessive stop risk rather than tightening to fit", () => {
    expect(planSoxlEntry({ ...entry, structuralStop: 70 })).toMatchObject({ ok: false, reason: "stop_risk_exceeded" });
  });
  it("evaluates exits from price + session low/high (never bid/ask — production quotes rarely carry them) and takes protection before targets", () => {
    expect(monitorSoxl({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 100, dayLow: 90, dayHigh: 110, observedAt: 99000 }, position: held, thesisInvalidated: false }))
      .toMatchObject({ action: "stop_full", exitQty: 10 });
  });
  it("catches an intraday stop touch even when the current price has recovered above it", () => {
    // Session low touched 90 (below the 94 stop) but price recovered to 100 —
    // must still fire on the low, matching position-monitor/route.ts.
    expect(monitorSoxl({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 100, dayLow: 90, dayHigh: null, observedAt: 99000 }, position: held, thesisInvalidated: false }))
      .toMatchObject({ action: "stop_full" });
  });
  it("does not fabricate an exit when data is stale", () => {
    expect(monitorSoxl({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 90, dayLow: null, dayHigh: null, observedAt: 0 }, position: held, thesisInvalidated: true }))
      .toMatchObject({ action: "data_unavailable", blockNewEntries: true });
  });
  it("does not fabricate an exit when price is missing/invalid", () => {
    expect(monitorSoxl({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 0, dayLow: null, dayHigh: null, observedAt: 99000 }, position: held, thesisInvalidated: false }))
      .toMatchObject({ action: "data_unavailable", blockNewEntries: true });
  });
  it("takes partial profit once and protects the remaining runner", () => {
    expect(monitorSoxl({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 105, dayLow: 100, dayHigh: 111, observedAt: 99000 }, position: held, thesisInvalidated: false }))
      .toMatchObject({ action: "partial_target", exitQty: 5 });
    expect(monitorSoxl({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 105, dayLow: 100, dayHigh: 111, observedAt: 99000 }, position: { ...held, qty: 5, partialTaken: true }, thesisInvalidated: false }))
      .toMatchObject({ action: "runner_hold" });
  });
  it("falls back to price alone when no session range is available (never invents one)", () => {
    expect(monitorSoxl({ now: 100000, maxQuoteAgeMs: 60000, quote: { price: 90, dayLow: null, dayHigh: null, observedAt: 99000 }, position: held, thesisInvalidated: false }))
      .toMatchObject({ action: "stop_full" });
  });
});
