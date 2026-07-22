import { describe, expect, it } from "vitest";
import { projectPaperExitPlan, resolvePaperPositionHorizon } from "@/lib/trading/paper-exit-plan";

const now = new Date("2026-07-21T20:00:00.000Z");

function plan(overrides: Record<string, unknown> = {}) {
  return projectPaperExitPlan({
    position: {
      id: "position-1",
      symbol: "AVGO",
      market: "us",
      current_price: 310,
      stop_loss: 280,
      price_target: 360,
      opened_at: "2026-07-20T14:00:00.000Z",
      ...((overrides.position as object | undefined) ?? {}),
    },
    signal: {
      analyst_score: 74,
      created_at: "2026-07-21T14:00:00.000Z",
      ...((overrides.signal as object | undefined) ?? {}),
    },
    entryThreshold: Number(overrides.entryThreshold ?? 60),
    hysteresis: Number(overrides.hysteresis ?? 15),
    maxScoreAgeSessions: Number(overrides.maxScoreAgeSessions ?? 2),
    horizonDays: Number(overrides.horizonDays ?? 10),
    horizonSource: (overrides.horizonSource as "entry" | undefined) ?? "entry",
    now,
  });
}

describe("paper exit-plan projection", () => {
  it("shows a healthy held position with the same score threshold inputs as PositionMonitor", () => {
    const result = plan();
    expect(result.state).toBe("hold");
    expect(result.scoreExitThreshold).toBe(45);
    expect(result.scoreFresh).toBe(true);
    expect(result.stopPrice).toBe(280);
    expect(result.targetPrice).toBe(360);
    expect(result.market).toBe("us");
  });

  it("does not let a stale score trigger an exit", () => {
    const result = plan({
      signal: { analyst_score: 20, created_at: "2026-07-15T14:00:00.000Z" },
      maxScoreAgeSessions: 2,
    });
    expect(result.scoreFresh).toBe(false);
    expect(result.scoreAgeSessions).toBeGreaterThan(2);
    expect(result.state).toBe("hold");
  });

  it("keeps a cleared target null and leaves mechanical protection visible", () => {
    const result = plan({ position: { price_target: null, stop_loss: 300 } });
    expect(result.targetPrice).toBeNull();
    expect(result.stopPrice).toBe(300);
    expect(result.state).toBe("hold");
  });

  it("uses PositionMonitor precedence when several exit conditions are due", () => {
    const result = plan({
      position: {
        opened_at: "2026-07-01T14:00:00.000Z",
        current_price: 250,
        stop_loss: 280,
        price_target: 240,
      },
      signal: { analyst_score: 20, created_at: "2026-07-21T14:00:00.000Z" },
      horizonDays: 5,
    });
    expect(result.state).toBe("time_exit_due");
  });

  it("uses a fresh below-threshold score before a reached stop", () => {
    const result = plan({
      position: { current_price: 270, stop_loss: 280 },
      signal: { analyst_score: 44, created_at: "2026-07-21T14:00:00.000Z" },
    });
    expect(result.state).toBe("score_exit_due");
  });

  it("never applies score exits to a hedge", () => {
    const result = plan({
      position: { position_role: "hedge", current_price: 310 },
      signal: { analyst_score: 10, created_at: "2026-07-21T14:00:00.000Z" },
    });
    expect(result.isHedge).toBe(true);
    expect(result.scoreFresh).toBe(false);
    expect(result.state).toBe("hold");
  });

  it("preserves market identity for India projections", () => {
    const result = plan({ position: { symbol: "RELIANCE", market: "india" } });
    expect(result.market).toBe("india");
    expect(result.positionId).toBe("position-1");
  });
});
describe("paper position horizon resolution", () => {
  it("grandfathers a position onto its entry horizon", () => {
    expect(resolvePaperPositionHorizon({
      storedHorizon: 10,
      isHedge: false,
      existingPositionsPolicy: "grandfather",
      currentHorizonDays: 20,
      currentHorizonSource: "champion",
    })).toEqual({ days: 10, source: "entry" });
  });

  it("uses the current governed horizon when policy applies to existing positions", () => {
    expect(resolvePaperPositionHorizon({
      storedHorizon: 10,
      isHedge: false,
      existingPositionsPolicy: "apply",
      currentHorizonDays: 20,
      currentHorizonSource: "champion",
    })).toEqual({ days: 20, source: "champion" });
  });
});
