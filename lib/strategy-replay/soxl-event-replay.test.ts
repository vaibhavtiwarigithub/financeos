import { describe, expect, it } from "vitest";
import { replaySoxlPullback } from "./soxl-event-replay";
import type { Bar } from "./compile";

function fixture(count = 290) {
  const sessions = Array.from({ length: count }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
  // Clear long-term trend with a sharp pullback at the end. The last signals
  // occur after the 200-day average is established and Wilder RSI falls < 35.
  const soxx = sessions.map((session, i): Bar => {
    const close = i < 250 ? 100 + i * 0.5 : 225 - (i - 250) * 1.1;
    return { session, open: close, high: close + 1, low: close - 1, close };
  });
  const soxl = sessions.map((session): Bar => ({ session, open: 100, high: 102, low: 98, close: 100 }));
  const vix = sessions.map((session): Bar => ({ session, open: 20, high: 21, low: 19, close: 20 }));
  const provenance = {
    SOXX: { provider: "fixture", priceBasis: "adjusted", provenanceVersion: "test-v1" },
    SOXL: { provider: "fixture", priceBasis: "adjusted", provenanceVersion: "test-v1" },
    VIX: { provider: "fixture", priceBasis: "index", provenanceVersion: "test-v1" },
  };
  return { sessions, soxx, soxl, vix, provenance };
}

describe("SOXX to SOXL daily event replay", () => {
  it("fails closed on insufficient sessions or mismatched instruments", () => {
    const f = fixture(220);
    expect(replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, vixBars: f.vix, provenance: f.provenance }).status).toBe("insufficient_data");
    const g = fixture();
    const result = replaySoxlPullback({ signalBars: g.soxx, executionBars: g.soxl.slice(1), vixBars: g.vix, provenance: g.provenance });
    expect(result.status).toBe("insufficient_data");
    expect(result.limitations.join(" ")).toMatch(/identical session coverage/);
  });

  it("uses the next session open and resolves same-bar stop/target collisions to the stop", () => {
    const f = fixture();
    // The signal is active in the late pullback; locate its next-session fill
    // from the result rather than relying on a particular RSI rounding point.
    const result = replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, vixBars: f.vix, provenance: f.provenance });
    expect(result.status).toBe("diagnostic_only");
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.factorScenarios).toHaveLength(7);
    const trade = result.trades[0];
    expect(trade.entrySession).toBe(f.sessions[f.sessions.indexOf(trade.signalSession) + 1]);
    expect(trade.exitReason).toBe("time");

    const entryIndex = f.sessions.indexOf(trade.entrySession);
    f.soxl[entryIndex + 1] = { session: f.sessions[entryIndex + 1], open: 100, high: 130, low: 90, close: 110 };
    const collision = replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, vixBars: f.vix, provenance: f.provenance });
    expect(collision.trades[0].exitReason).toBe("stop");
    expect(collision.trades[0].exitPrice).toBeLessThan(collision.trades[0].stopPrice);
  });

  it("runs the SOXX/SOXL baseline without VIX and labels each VIX variant insufficient", () => {
    const f = fixture();
    const { VIX: _vix, ...equityProvenance } = f.provenance;
    const result = replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, provenance: equityProvenance });
    expect(result.status).toBe("diagnostic_only");
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.factorScenarios).toHaveLength(7);
    expect(result.factorScenarios.every((row) => row.status === "insufficient_data" && row.summary === null)).toBe(true);
    expect(result.assumptions.entry).toMatch(/VIX filters are unavailable/);
  });

  it("does not evaluate VIX filters when the VIX sessions do not align", () => {
    const f = fixture();
    const result = replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, vixBars: f.vix.slice(1), provenance: f.provenance });
    expect(result.status).toBe("diagnostic_only");
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.factorScenarios.every((row) => row.status === "insufficient_data" && row.summary === null)).toBe(true);
  });

  it("uses adverse stop-gap fills and does not credit favorable target gaps", () => {
    const f = fixture();
    const baseline = replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, vixBars: f.vix, provenance: f.provenance });
    const entryIndex = f.sessions.indexOf(baseline.trades[0].entrySession);
    f.soxl[entryIndex + 1] = { session: f.sessions[entryIndex + 1], open: 90, high: 100, low: 88, close: 92 };
    const gapStop = replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, vixBars: f.vix, provenance: f.provenance });
    expect(gapStop.trades[0].exitPrice).toBeCloseTo(90 * (1 - 25 / 10_000), 6);

    f.soxl[entryIndex + 1] = { session: f.sessions[entryIndex + 1], open: 130, high: 135, low: 125, close: 132 };
    const gapTarget = replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, vixBars: f.vix, provenance: f.provenance });
    expect(gapTarget.trades[0].exitReason).toBe("target");
    expect(gapTarget.trades[0].exitPrice).toBeLessThan(gapTarget.trades[0].targetPrice);
  });

  it("does not accept unprovenanced data or claim an independent holdout", () => {
    const f = fixture();
    const result = replaySoxlPullback({ signalBars: f.soxx, executionBars: f.soxl, vixBars: f.vix,
      provenance: { ...f.provenance, SOXL: { ...f.provenance.SOXL, provenanceVersion: "v0_unprovenanced" } } });
    expect(result.status).toBe("insufficient_data");
    expect(result.summary).toBeNull();
  });
});
