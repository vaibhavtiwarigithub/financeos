import { describe, expect, it } from "vitest";
import {
  buildEarningsHoldingTargets,
  filterTargetsForCachedEvents,
} from "./earnings-holding-targets";

describe("earnings holding targets", () => {
  it("keeps paper and live observations separate while deduplicating accounts", () => {
    const targets = buildEarningsHoldingTargets({
      paperPositions: [{ symbol: "MSFT", current_price: 500, stop_loss: 465, resolved_horizon_days: 10 }],
      liveSnapshots: [
        { symbol: "MSFT", current_price: 501 },
        { symbol: "MSFT", current_price: 502 },
      ],
      defaultHorizonSessions: 10,
    });
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      environment: "paper", symbol: "MSFT", stopDistancePct: 0.07, horizonSessions: 10,
    });
    expect(targets[1]).toMatchObject({
      environment: "live", symbol: "MSFT", stopDistancePct: null, horizonSessions: 10,
    });
  });

  it("refuses unpriced holdings and bounds each environment", () => {
    const targets = buildEarningsHoldingTargets({
      paperPositions: [
        { symbol: "BAD", current_price: null },
        { symbol: "A", current_price: 10 },
        { symbol: "B", current_price: 20 },
      ],
      liveSnapshots: [{ symbol: "C", current_price: 30 }, { symbol: "D", current_price: 40 }],
      defaultHorizonSessions: 99,
      maxPerEnvironment: 1,
    });
    expect(targets.map(row => `${row.environment}:${row.symbol}`)).toEqual(["paper:A", "live:C"]);
    expect(targets.every(row => row.horizonSessions === 20)).toBe(true);
  });

  it("admits provider work only for cached events inside each horizon", () => {
    const targets = buildEarningsHoldingTargets({
      paperPositions: [
        { symbol: "IN", current_price: 10, resolved_horizon_days: 5 },
        { symbol: "OUT", current_price: 20, resolved_horizon_days: 5 },
        { symbol: "NONE", current_price: 30, resolved_horizon_days: 5 },
      ],
      liveSnapshots: [],
      defaultHorizonSessions: 10,
    });
    const eventDates = new Map([["IN", "2026-08-01"], ["OUT", "2026-08-20"]]);
    const sessions = new Map([["2026-08-01", 2], ["2026-08-20", 12]]);
    expect(filterTargetsForCachedEvents(targets, eventDates, date => sessions.get(date) ?? null)
      .map(row => row.symbol)).toEqual(["IN"]);
  });
});
