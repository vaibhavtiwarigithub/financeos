import { describe, expect, it } from "vitest";
import { evaluateCapitalRotationShadow, type RotationHolding } from "@/lib/trading/capital-rotation";

const baseHolding = (over: Partial<RotationHolding> = {}): RotationHolding => ({
  id: "00000000-0000-0000-0000-000000000010",
  symbol: "WEAK",
  market: "us",
  qty: 10,
  avgCost: 100,
  currentPrice: 100,
  openedAt: "2026-06-01T00:00:00.000Z",
  priceTarget: 130,
  stopLoss: 80,
  exitReason: null,
  score: 61,
  ...over,
});

const config = {
  shadowEnabled: true,
  marginScore: 12,
  minHoldingDays: 2,
  exitScoreThreshold: 50,
  nearTargetPct: 0.03,
  nearStopPct: 0.03,
};

const candidate = {
  signalId: "00000000-0000-0000-0000-000000000100",
  symbol: "STRONG",
  market: "us" as const,
  currency: "USD" as const,
  score: 80,
  targetNotional: 900,
  cash: 100,
};

describe("evaluateCapitalRotationShadow", () => {
  it("plans a shadow rotation only when edge and funding clear", () => {
    const result = evaluateCapitalRotationShadow({
      candidate,
      holdings: [baseHolding()],
      config,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(result.status).toBe("planned");
    expect(result.eligible).toBe(true);
    expect(result.source?.symbol).toBe("WEAK");
    expect(result.scoreEdge).toBe(19);
  });

  it("rejects holdings that PositionMonitor would own as exits", () => {
    const result = evaluateCapitalRotationShadow({
      candidate,
      holdings: [baseHolding({ exitReason: "llm_exit" })],
      config,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("no_sellable_holding");
    expect((result.gates.source_reject_counts as any).position_has_exit_reason).toBe(1);
  });

  it("requires a material score edge", () => {
    const result = evaluateCapitalRotationShadow({
      candidate: { ...candidate, score: 68 },
      holdings: [baseHolding({ score: 61 })],
      config,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("score_edge_below_margin");
  });

  it("does not use near-target winners as funding source", () => {
    const result = evaluateCapitalRotationShadow({
      candidate,
      holdings: [baseHolding({ currentPrice: 126, priceTarget: 128, score: 60 })],
      config,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(result.status).toBe("rejected");
    expect((result.gates.source_reject_counts as any).near_target).toBe(1);
  });

  it("does not cross markets", () => {
    const result = evaluateCapitalRotationShadow({
      candidate,
      holdings: [baseHolding({ market: "india" })],
      config,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("no_sellable_holding");
  });
});
