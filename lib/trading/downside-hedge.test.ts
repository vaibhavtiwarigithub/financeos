import { describe, expect, it } from "vitest";
import { buildHedgeMarketSnapshot, cooldownState, evaluateDownsideHedge, type HedgeConfig, type HedgeMarketSnapshot, type HedgeState } from "@/lib/trading/downside-hedge";

const config: HedgeConfig = {
  enabled: true,
  allowedSymbols: ["SH", "PSQ"],
  entryDangerScore: 60,
  exitDangerScore: 45,
  entryConfirmations: 2,
  exitConfirmations: 2,
  entryReturn20Pct: -4,
  entryDrawdown20Pct: -6,
  maxHoldingDays: 5,
  cooldownDays: 3,
};

const off: HedgeState = { state: "off", entryStreak: 0, exitStreak: 0, activeSymbol: null, activeSince: null, cooldownUntil: null };
const riskOff: HedgeMarketSnapshot = {
  asOf: "2026-07-15T21:00:00.000Z",
  dangerScore: 72,
  spyClose: 480,
  spySma50: 500,
  spyReturn5Pct: -2,
  spyReturn20Pct: -7,
  spyDrawdown20Pct: -8,
  qqqReturn20Pct: -8,
  dataFresh: true,
};

describe("evaluateDownsideHedge", () => {
  it("ships inert when disabled", () => {
    const result = evaluateDownsideHedge({ ...config, enabled: false }, off, riskOff);
    expect(result.action).toBe("none");
    expect(result.next.state).toBe("off");
  });

  it("requires persistent macro and technical confirmation", () => {
    const first = evaluateDownsideHedge(config, off, riskOff);
    expect(first.action).toBe("none");
    expect(first.next.state).toBe("armed");
    const second = evaluateDownsideHedge(config, first.next, { ...riskOff, asOf: "2026-07-16T21:00:00.000Z" });
    expect(second.action).toBe("enter");
    expect(second.symbol).toBe("SH");
  });

  it("selects PSQ only when Nasdaq weakness materially exceeds SPY", () => {
    const first = evaluateDownsideHedge(config, off, { ...riskOff, qqqReturn20Pct: -11 });
    const second = evaluateDownsideHedge(config, first.next, { ...riskOff, asOf: "2026-07-16T21:00:00.000Z", qqqReturn20Pct: -11 });
    expect(second.symbol).toBe("PSQ");
  });

  it("never enters on stale data", () => {
    const result = evaluateDownsideHedge(config, { ...off, state: "armed", entryStreak: 1 }, { ...riskOff, dataFresh: false });
    expect(result.action).toBe("none");
    expect(result.next.entryStreak).toBe(1);
  });

  it("requires persistent risk-on confirmation to exit", () => {
    const active: HedgeState = { state: "active", entryStreak: 2, exitStreak: 0, activeSymbol: "SH", activeSince: "2026-07-14T21:00:00.000Z", cooldownUntil: null };
    const riskOn = { ...riskOff, dangerScore: 35, spyClose: 510, spySma50: 500, spyReturn5Pct: 1, spyReturn20Pct: 2, spyDrawdown20Pct: -1 };
    const first = evaluateDownsideHedge(config, active, riskOn);
    expect(first.action).toBe("none");
    const second = evaluateDownsideHedge(config, first.next, { ...riskOn, asOf: "2026-07-16T21:00:00.000Z" });
    expect(second.action).toBe("exit");
    expect(second.next.state).toBe("exit_pending");
  });

  it("forces a time exit and honors cooldown", () => {
    const active: HedgeState = { state: "active", entryStreak: 2, exitStreak: 0, activeSymbol: "SH", activeSince: "2026-07-01T21:00:00.000Z", cooldownUntil: null };
    expect(evaluateDownsideHedge(config, active, riskOff).action).toBe("exit");

    const cooldown = cooldownState("2026-07-15T21:00:00.000Z", 3);
    const blocked = evaluateDownsideHedge(config, cooldown, riskOff);
    expect(blocked.action).toBe("none");
    expect(blocked.next.state).toBe("cooldown");
  });
});

describe("buildHedgeMarketSnapshot", () => {
  const rows = (count: number, start: number, step: number) => Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2026, 4, 1 + i)).toISOString().slice(0, 10),
    close: start + i * step,
  }));

  it("computes deterministic technical inputs from closing prices", () => {
    const snapshot = buildHedgeMarketSnapshot(rows(55, 120, -1), rows(55, 150, -1.5), 70, "2026-06-25T12:00:00Z");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.spyClose).toBe(66);
    expect(snapshot!.spySma50).toBeCloseTo(90.5);
    expect(snapshot!.spyReturn20Pct).toBeLessThan(0);
    expect(snapshot!.dataFresh).toBe(true);
  });

  it("fails closed with fewer than 50 SPY observations", () => {
    expect(buildHedgeMarketSnapshot(rows(49, 100, 1), [], 70, "2026-06-25T12:00:00Z")).toBeNull();
  });
});
