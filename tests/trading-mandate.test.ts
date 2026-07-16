import { describe, expect, it } from "vitest";
import { applyStrategyTilt, defaultMandate, hydrateMandate, resolveHorizonDays, tradingWeekdaysBetween } from "@/lib/trading-mandate";

describe("trading mandates", () => {
  it("keeps US and India defaults independent", () => {
    const us = defaultMandate("us");
    const india = defaultMandate("india");
    expect(us.market).toBe("us");
    expect(india.market).toBe("india");
    expect(us).not.toBe(india);
  });

  it("lets user governance override a champion horizon", () => {
    const mandate = { ...defaultMandate("us"), target_hold_days: 10, horizon_governance: "user" as const };
    expect(resolveHorizonDays(mandate, 20)).toEqual({ days: 10, source: "user" });
  });

  it("clamps agent horizon to the user mandate range", () => {
    const mandate = { ...defaultMandate("india"), min_hold_days: 5, max_hold_days: 15, horizon_governance: "agent" as const };
    expect(resolveHorizonDays(mandate, 20)).toEqual({ days: 15, source: "champion" });
    expect(resolveHorizonDays(mandate, 2)).toEqual({ days: 5, source: "champion" });
  });

  it("applies bounded strategy tilts without creating dimensions", () => {
    const tilted = applyStrategyTilt({ fundamental: 0.3, technical: 0.25 }, "momentum");
    expect(tilted.fundamental).toBeCloseTo(0.255);
    expect(tilted.technical).toBeCloseTo(0.3125);
    expect(Object.keys(tilted)).toEqual(["fundamental", "technical"]);
  });

  it("hydrates malformed rows into safe 2-20 day bounds", () => {
    const m = hydrateMandate("us", { horizon_style: "position", min_hold_days: -1, target_hold_days: 99, max_hold_days: 80, strategy_preference: "unknown", max_open_positions: 999, max_signal_age_sessions: -3 });
    expect(m.min_hold_days).toBe(2);
    expect(m.target_hold_days).toBe(20);
    expect(m.max_hold_days).toBe(20);
    expect(m.strategy_preference).toBe("balanced");
    expect(m.max_open_positions).toBe(50);
    expect(m.max_signal_age_sessions).toBe(0);
  });

  it("defaults per-market capacity and score freshness conservatively", () => {
    expect(defaultMandate("us").max_open_positions).toBe(10);
    expect(defaultMandate("india").max_signal_age_sessions).toBe(2);
  });

  it("counts weekdays rather than calendar days", () => {
    expect(tradingWeekdaysBetween(new Date("2026-07-10T15:00:00Z"), new Date("2026-07-13T15:00:00Z"))).toBe(1);
    expect(tradingWeekdaysBetween(new Date("2026-07-06T15:00:00Z"), new Date("2026-07-13T15:00:00Z"))).toBe(5);
  });
});
