import { describe, expect, it } from "vitest";
import { evaluateCapitalRotationShadow, type RotationHolding } from "@/lib/trading/capital-rotation";
import { DEFAULT_LIMITS } from "@/lib/portfolio/constructor";
import { replacementCapacity } from "@/lib/trading/rotation-capacity";

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
  fillPrice: 100,
};

describe("evaluateCapitalRotationShadow", () => {
  it("accepts the constructor's exact fractional quantity contract for a feasible post-swap replacement", () => {
    const result = evaluateCapitalRotationShadow({
      candidate: { ...candidate, targetNotional: 900, cash: 0, fillPrice: 100 },
      config,
      holdings: [baseHolding()],
      sizeForSource: source => replacementCapacity({
        book: [
          { symbol: "WEAK", sector: "healthcare", valuePct: 10, beta: null, dailyVol: null },
          { symbol: "OTHER", sector: "energy", valuePct: 40, beta: null, dailyVol: null },
        ],
        sourceSymbol: source.symbol, sellNotional: 1_000, symbol: "STRONG", market: "us",
        sector: "technology", dailyVol: 0.02, intendedNotional: 900, nav: 10_000, cash: 0,
        fillPrice: 100, limits: DEFAULT_LIMITS, maxPerSector: 4,
      }),
    });
    expect(result.eligible).toBe(true);
    expect(result.source?.symbol).toBe("WEAK");
    expect(result.buyQty).toBe(9);
    expect(result.buyQty! * 100).toBe(result.buyNotional);
  });

  it("considers the next weakest holding when the weakest cannot free the required capacity", () => {
    const result = evaluateCapitalRotationShadow({ candidate, config,
      holdings: [baseHolding(), baseHolding({ id: "second", symbol: "SECOND", score: 65 })],
      sizeForSource: h => h.symbol === "WEAK"
        ? { buyNotional: 0, buyQty: null, reason: "post_swap_sector_count_cap" }
        : { buyNotional: 400, buyQty: 4, reason: null },
    });
    expect(result.eligible).toBe(true);
    expect(result.source?.symbol).toBe("SECOND");
    expect(result.buyNotional).toBe(400);
    expect(result.buyQty).toBe(4);
  });

  it("rejects a replacement whose quantity and notional do not reconcile exactly", () => {
    const result = evaluateCapitalRotationShadow({
      candidate,
      config,
      holdings: [baseHolding()],
      sizeForSource: () => ({ buyNotional: 400, buyQty: 3.999999, reason: null }),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("no_feasible_replacement");
    expect(result.buyQty).toBeNull();
  });

  it.each([75, 140])("leaves an already-crossed stop/target to the exit engine (%s)", currentPrice => {
    const result = evaluateCapitalRotationShadow({ candidate, config, holdings: [baseHolding({ currentPrice })] });
    expect(result.reason).toBe("no_sellable_holding");
  });
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

  it("rejects a crypto candidate from the equity rotation ledger", () => {
    const result = evaluateCapitalRotationShadow({
      candidate: { ...candidate, symbol: "ETH-USD", assetClass: "crypto" }, config, holdings: [baseHolding()],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("crypto_excluded_from_equity_rotation");
  });

  it("cannot sell and rebuy the candidate's existing position", () => {
    const result = evaluateCapitalRotationShadow({
      candidate,
      holdings: [baseHolding({ symbol: "strong", score: 55 })],
      config,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(result.reason).toBe("no_sellable_holding");
    expect((result.gates.source_reject_counts as any).candidate_already_held).toBe(1);
  });

  it("does not relabel a canonical exit-due or stale-priced holding as rotation", () => {
    const result = evaluateCapitalRotationShadow({
      candidate,
      holdings: [
        baseHolding({ id: "exit", exitPlanState: "score_exit_due" }),
        baseHolding({ id: "stale", symbol: "STALE", priceFresh: false }),
      ],
      config,
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(result.reason).toBe("no_sellable_holding");
    expect((result.gates.source_reject_counts as any)["position_exit_due:score_exit_due"]).toBe(1);
    expect((result.gates.source_reject_counts as any).missing_fresh_price).toBe(1);
  });
});
