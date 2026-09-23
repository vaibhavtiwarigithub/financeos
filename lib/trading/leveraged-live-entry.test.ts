import { describe, expect, it } from "vitest";
import { planLeveragedLiveEntry } from "./leveraged-live-entry";

const entry = {
  policy: { version: "live-v1", maxQuoteAgeMs: 60000, maxSpreadBps: 30, maxMonitorAgeMs: 60000,
    atrStopMultiple: 2, maxStopPct: 15, targetAtrMultiple: 3 },
  now: 100000, quote: { bid: 99.9, ask: 100, observedAt: 99000 }, signalAt: 80000,
  lastExitAt: null, signalSession: "2026-09-21", expectedSignalSession: "2026-09-21",
  entryWindowOpen: true, monitorVerifiedAt: 99000, trendQualified: true,
  atr: 3, structuralStop: 95, leaseUsd: 200, existingLivePositions: [],
};

describe("planLeveragedLiveEntry", () => {
  it("binds geometry to ask and sizes to the full lease headroom", () => {
    expect(planLeveragedLiveEntry(entry)).toMatchObject({ ok: true, entry: 100, stop: 94, target: 109, maxNotional: 200 });
  });
  it("requires working monitoring and fresh quotes", () => {
    expect(planLeveragedLiveEntry({ ...entry, monitorVerifiedAt: 0 })).toMatchObject({ ok: false, reason: "monitor_unhealthy" });
    expect(planLeveragedLiveEntry({ ...entry, quote: { ...entry.quote, observedAt: 100001 } })).toMatchObject({ ok: false, reason: "invalid_quote" });
  });
  it("refuses without lease capacity (the safe default)", () => {
    expect(planLeveragedLiveEntry({ ...entry, leaseUsd: 0 })).toMatchObject({ ok: false, reason: "no_lease_capacity" });
  });
  it("clamps to remaining headroom across the whole 4-symbol sleeve", () => {
    expect(planLeveragedLiveEntry({ ...entry, existingLivePositions: [{ symbol: "SOXL", marketValue: 180 }] }))
      .toMatchObject({ ok: true, maxNotional: 20 });
  });
  it("denies entry when the sleeve is already full", () => {
    expect(planLeveragedLiveEntry({ ...entry, existingLivePositions: [{ symbol: "TQQQ", marketValue: 200 }] }))
      .toMatchObject({ ok: false, reason: "no_sleeve_capacity" });
  });
  it("prevents re-entry using the signal that preceded an exit", () => {
    expect(planLeveragedLiveEntry({ ...entry, lastExitAt: 90000 })).toMatchObject({ ok: false, reason: "fresh_signal_required_after_exit" });
  });
  it("rejects excessive stop risk rather than tightening to fit", () => {
    expect(planLeveragedLiveEntry({ ...entry, structuralStop: 70 })).toMatchObject({ ok: false, reason: "stop_risk_exceeded" });
  });
});
