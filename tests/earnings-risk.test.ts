import { describe, expect, it } from "vitest";
import {
  calculateMoveProxy,
  earningsRiskIdempotencyKey,
  earningsRiskVerdict,
  selectPostEventExpiry,
  tradingSessionsBetween,
  type EarningsEventRisk,
} from "@/lib/risk/earnings-risk";

const event: EarningsEventRisk = {
  market: "us",
  symbol: "AAPL",
  reportDate: "2026-07-30",
  reportSession: "amc",
  sessionsUntilReport: 1,
  source: "robinhood",
  observedAt: "2026-07-29T20:00:00.000Z",
  confidence: "confirmed",
  status: "available",
  observations: [],
};

const leg = (overrides: Partial<{
  instrumentId: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  openInterest: number;
  updatedAt: string | null;
}> = {}) => ({
  instrumentId: "id",
  bid: 4,
  ask: 4.4,
  bidSize: 10,
  askSize: 10,
  openInterest: 100,
  updatedAt: "2026-07-29T19:59:00.000Z",
  ...overrides,
});

describe("earnings-aware risk", () => {
  it("counts market sessions rather than calendar days and skips holidays", () => {
    expect(tradingSessionsBetween("us", "2026-07-02", "2026-07-06")).toBe(1);
    expect(tradingSessionsBetween("india", "2026-10-19", "2026-10-21")).toBe(1);
    expect(tradingSessionsBetween("us", "2026-07-06", "2026-07-06")).toBe(0);
  });

  it("returns null instead of a fabricated session count when the gap is unknowable", () => {
    // Regression. The 400-iteration guard used to return whatever it had counted
    // when the target was never reached, so these produced 282, 282 and -280 —
    // confident-looking numbers that the Risk page rendered and the ledger stored.
    expect(tradingSessionsBetween("us", "2026-07-02", "not-a-date")).toBeNull();
    expect(tradingSessionsBetween("us", "2026-07-02", "")).toBeNull();
    expect(tradingSessionsBetween("us", "2026-07-02", "2030-01-01")).toBeNull(); // beyond the guard
    expect(tradingSessionsBetween("us", "bad-input", "2026-07-06")).toBeNull();
    // Well-formed but impossible dates must not pass the regex alone.
    expect(tradingSessionsBetween("us", "2026-07-02", "2026-02-31")).toBeNull();
  });

  it("signs the count by direction so a past report reads negative", () => {
    const fwd = tradingSessionsBetween("us", "2026-07-02", "2026-07-06");
    const back = tradingSessionsBetween("us", "2026-07-06", "2026-07-02");
    expect(fwd).toBe(1);
    expect(back).toBe(-1);
  });

  it("uses same-day expiry for BMO but requires a later expiry for AMC/unknown", () => {
    const expiries = ["2026-07-30", "2026-07-31", "2026-08-07"];
    expect(selectPostEventExpiry(expiries, "2026-07-30", "bmo")).toBe("2026-07-30");
    expect(selectPostEventExpiry(expiries, "2026-07-30", "amc")).toBe("2026-07-31");
    expect(selectPostEventExpiry(expiries, "2026-07-30", "unknown")).toBe("2026-07-31");
  });

  it("computes a usable same-strike mid-price move proxy", () => {
    const proxy = calculateMoveProxy({
      symbol: "AAPL",
      source: "robinhood",
      reportDate: "2026-07-30",
      reportSession: "amc",
      expiry: "2026-07-31",
      spot: 100,
      strike: 100,
      call: leg(),
      put: leg({ instrumentId: "put", bid: 3.8, ask: 4.2 }),
      stopDistancePct: 0.07,
      now: new Date("2026-07-29T20:00:00.000Z"),
    });
    expect(proxy.quality).toBe("usable");
    expect(proxy.moveProxyPct).toBeCloseTo(0.082);
    expect(proxy.stopToMoveRatio).toBeCloseTo(0.07 / 0.082);
  });

  it.each([
    ["crossed", leg({ bid: 5, ask: 4 }), "unavailable"],
    ["zero bid", leg({ bid: 0 }), "illiquid"],
    ["no open interest or size", leg({ openInterest: 0, bidSize: 0, askSize: 0 }), "illiquid"],
    ["wide spread", leg({ bid: 1, ask: 4 }), "wide_spread"],
    ["stale", leg({ updatedAt: "2026-07-29T18:00:00.000Z" }), "stale"],
  ])("rejects %s quote evidence", (_name, call, quality) => {
    const proxy = calculateMoveProxy({
      symbol: "AAPL", source: "robinhood",
      reportDate: "2026-07-30", reportSession: "amc",
      expiry: "2026-07-31", spot: 100, strike: 100,
      call, put: leg({ instrumentId: "put" }),
      now: new Date("2026-07-29T20:00:00.000Z"),
    });
    expect(proxy.quality).toBe(quality);
  });

  it("never changes behavior in shadow mode even when the counterfactual sizes down", () => {
    const proxy = calculateMoveProxy({
      symbol: "AAPL", source: "robinhood",
      reportDate: "2026-07-30", reportSession: "amc",
      expiry: "2026-07-31", spot: 100, strike: 100,
      call: leg(), put: leg({ instrumentId: "put" }),
      stopDistancePct: 0.03,
      now: new Date("2026-07-29T20:00:00.000Z"),
    });
    const verdict = earningsRiskVerdict(event, proxy, 10);
    expect(verdict.counterfactualVerdict).toBe("size_down");
    expect(verdict.behaviorChanged).toBe(false);
  });

  it("builds stable retry keys and isolates markets", () => {
    const base = {
      environment: "paper",
      decisionKind: "entry",
      signalId: "42",
      symbol: "RELIANCE",
      observedSession: "2026-07-29",
    };
    const us = earningsRiskIdempotencyKey({ ...base, market: "us" });
    expect(earningsRiskIdempotencyKey({ ...base, market: "us" })).toBe(us);
    expect(earningsRiskIdempotencyKey({ ...base, market: "india" })).not.toBe(us);
  });
});
