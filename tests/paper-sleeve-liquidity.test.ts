import { describe, expect, it } from "vitest";
import { paperLeveragedLiquidity, leveragedSleeveHeadroom, leveragedPaperEntrySize } from "@/lib/trading/leveraged-sleeve-risk";
import { constructPortfolio, DEFAULT_LIMITS } from "@/lib/portfolio/constructor";
import { paperAllocationSpend } from "@/lib/trading/paper-quantity";
import { simulatePortfolio } from "@/lib/simulation/portfolio-simulator";

const input = { market: "us" as const, nav: 10000, cash: 10000, maxGrossExposurePct: 100, positions: [] };

describe("US paper operating liquidity within the approved leveraged sleeve", () => {
  it("scales the combined maximum and distinct minimum with current NAV", () => {
    for (const [nav, ceiling, minimum] of [[10000, 500, 50], [25000, 1250, 125], [2000, 100, 10]]) {
      expect(leveragedSleeveHeadroom({ nav, positions: [] })).toEqual({ ok: true, headroom: ceiling });
      expect(leveragedPaperEntrySize(nav, minimum - 0.01).ok).toBe(false);
      expect(leveragedPaperEntrySize(nav, minimum).ok).toBe(true);
    }
  });
  it("keeps unused sleeve cash available before ordinary buys consume it", () => {
    expect(paperLeveragedLiquidity(input)).toMatchObject({ ok: true, reserve: 500, reserveFunded: 500,
      reserveShortfall: 0, deployableCash: 9500, maxGrossExposurePct: 95 });
  });
  it("does not reserve invested leveraged dollars a second time", () => {
    expect(paperLeveragedLiquidity({ ...input, cash: 1000, positions: [{ symbol: "SOXL", marketValue: 250 }] }))
      .toMatchObject({ ok: true, reserve: 250, deployableCash: 750, maxGrossExposurePct: 97.5 });
    expect(paperLeveragedLiquidity({ ...input, cash: 500, positions: [{ symbol: "SQQQ", marketValue: 500 }] }))
      .toMatchObject({ ok: true, reserve: 0, deployableCash: 500, maxGrossExposurePct: 100 });
  });
  it("reports already-invested shortfall without inventing cash or selling holdings", () => {
    expect(paperLeveragedLiquidity({ ...input, cash: 0.0005 })).toMatchObject({ ok: true,
      deployableCash: 0, reserveShortfall: 499.9995, reserveFunded: 0.0005 });
  });
  it("preserves stricter risk limits and leaves India allocation unchanged", () => {
    expect(paperLeveragedLiquidity({ ...input, maxGrossExposurePct: 80 })).toMatchObject({ ok: true, maxGrossExposurePct: 80 });
    expect(paperLeveragedLiquidity({ ...input, market: "india", cash: 4000, maxGrossExposurePct: 90 }))
      .toMatchObject({ ok: true, reserve: 0, deployableCash: 4000, maxGrossExposurePct: 90 });
  });
  it("refuses invalid leveraged marks and non-finite accounting", () => {
    for (const patch of [{ cash: NaN }, { nav: 0 }, { maxGrossExposurePct: 101 }, { positions: [{ symbol: "TQQQ", marketValue: NaN }] }])
      expect(paperLeveragedLiquidity({ ...input, ...patch }).ok).toBe(false);
  });
  it("composes constructor and spend limits across successive ordinary buys", () => {
    const liquidity = paperLeveragedLiquidity({ ...input, cash: 1000 });
    if (!liquidity.ok) throw new Error("fixture");
    const result = constructPortfolio([{ symbol: "AAA", valuePct: 90, sector: "A", beta: null, dailyVol: null }],
      [{ symbol: "BBB", market: "us", proposedSizePct: 20, sector: "B", beta: null, dailyVol: null }],
      { ...DEFAULT_LIMITS, maxNameExposurePct: 20, maxSectorExposurePct: 60, maxGrossExposurePct: liquidity.maxGrossExposurePct });
    const spend = paperAllocationSpend(10000, liquidity.deployableCash, result.orders[0].finalSizePct);
    expect(spend).toBeCloseTo(500);
    expect(1000 - spend!).toBeCloseTo(500);
  });
});

describe("paired full-book opportunity-cost scenarios (synthetic, not historical evidence)", () => {
  function scenario(coreMove: number, leveragedMove: number | null) {
    const policy = { market: "us" as const, currency: "USD" as const, initialCash: 10000, maxOpenNames: 8, allowFractionalShares: true };
    const run = (reserve: boolean) => {
      const liquidity = paperLeveragedLiquidity(input);
      if (!liquidity.ok) throw new Error("fixture");
      const events: any[] = [{ id: "core", session: "2026-10-23", symbol: "CORE", kind: "entry", price: 100,
        cashAllocation: reserve ? liquidity.deployableCash : 10000, costPct: 0.001 }];
      if (leveragedMove != null) events.push({ id: "setup", session: "2026-10-26", symbol: "SOXL", kind: "entry", price: 100,
        cashAllocation: 500, costPct: 0.001 });
      const result = simulatePortfolio(policy, events);
      const nav = result.endingCash + result.positions.reduce((sum, p) => sum + p.quantity * 100 *
        (1 + (p.symbol === "CORE" ? coreMove : leveragedMove ?? 0)), 0);
      return { result, nav };
    };
    return { baseline: run(false), reserved: run(true) };
  }
  it("funds a qualified winning setup without a forced source sale", () => {
    const pair = scenario(0, 0.08);
    expect(pair.baseline.result.rejections).toContainEqual({ eventId: "setup", reason: "insufficient_cash" });
    expect(pair.reserved.result.rejections).toEqual([]);
    expect(pair.reserved.result.fills.every(fill => fill.kind === "entry")).toBe(true);
    expect(pair.reserved.nav).toBeGreaterThan(pair.baseline.nav);
    expect(pair.reserved.result.endingCash).toBeGreaterThanOrEqual(-1e-9);
  });
  it("exposes cash drag when no leveraged opportunity occurs", () => {
    const pair = scenario(0.1, null);
    expect(pair.reserved.nav).toBeLessThan(pair.baseline.nav);
    expect(pair.reserved.result.endingCash).toBeCloseTo(500);
  });
  it("does not turn a funded losing setup into claimed improvement", () => {
    const pair = scenario(0.01, -0.1);
    expect(pair.reserved.nav).toBeLessThan(pair.baseline.nav);
  });
});
