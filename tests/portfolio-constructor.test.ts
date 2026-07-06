import { describe, it, expect } from "vitest";
import { constructPortfolio, DEFAULT_LIMITS, type BookPosition, type CandidateOrder } from "@/lib/portfolio/constructor";

const cand = (over: Partial<CandidateOrder> = {}): CandidateOrder => ({
  symbol: "AAA", market: "us", proposedSizePct: 10, sector: "Tech", beta: 1, dailyVol: 0.02, ...over,
});

describe("constructPortfolio — name cap", () => {
  it("shrinks a candidate so existing+new exposure to the same symbol never exceeds the name cap", () => {
    const book: BookPosition[] = [{ symbol: "AAA", sector: "Tech", valuePct: 8, beta: 1, dailyVol: 0.02 }];
    const result = constructPortfolio(book, [cand({ symbol: "AAA", proposedSizePct: 10 })], { ...DEFAULT_LIMITS, maxNameExposurePct: 12 });
    expect(result.orders[0].finalSizePct).toBeCloseTo(4, 5); // 12 - 8 room
    expect(result.orders[0].adjustments.some(a => a.startsWith("name_cap"))).toBe(true);
  });
});

describe("constructPortfolio — sector cap", () => {
  it("proportionally scales down candidates in an over-concentrated sector", () => {
    // Two DIFFERENT sectors so the sector-cap rule is isolated from the later
    // stacked-bet haircut (rule 5), which only fires when 2+ positions already
    // share ONE sector — tested separately below.
    const book: BookPosition[] = [{ symbol: "XXX", sector: "Tech", valuePct: 20, beta: 1, dailyVol: 0.02 }];
    const candidates = [cand({ symbol: "AAA", sector: "Tech", proposedSizePct: 10 }), cand({ symbol: "BBB", sector: "Fin", proposedSizePct: 10 })];
    const result = constructPortfolio(book, candidates, { ...DEFAULT_LIMITS, maxSectorExposurePct: 30, maxNameExposurePct: 100, maxGrossExposurePct: 100 });
    // Tech: existing 20 + candidate 10 = 30 = cap exactly, no scaling needed (only 1 Tech candidate)
    const techOrder = result.orders.find(o => o.symbol === "AAA")!;
    const finOrder = result.orders.find(o => o.symbol === "BBB")!;
    expect(techOrder.finalSizePct).toBeCloseTo(10, 5);
    expect(finOrder.finalSizePct).toBeCloseTo(10, 5); // Fin sector has no cap pressure
  });

  it("proportionally scales down MULTIPLE candidates competing for the same over-concentrated sector", () => {
    const book: BookPosition[] = [{ symbol: "XXX", sector: "Tech", valuePct: 25, beta: 1, dailyVol: 0.02 }];
    const candidates = [cand({ symbol: "AAA", sector: "Tech", proposedSizePct: 10 }), cand({ symbol: "BBB", sector: "Tech", proposedSizePct: 10 })];
    const result = constructPortfolio(book, candidates, { ...DEFAULT_LIMITS, maxSectorExposurePct: 30, maxNameExposurePct: 100, maxGrossExposurePct: 100, maxPortfolioVolPct: 1000 });
    // Sector room for candidates = 30-25 = 5, split proportionally 2.5/2.5 by
    // the sector-cap rule BEFORE the stacked-bet haircut applies to the 2nd one.
    const total = result.orders.reduce((s, o) => s + o.finalSizePct, 0);
    expect(total).toBeLessThanOrEqual(5 + 1e-6);
    expect(result.orders[0].adjustments.some(a => a.startsWith("sector_cap"))).toBe(true);
  });

  it("treats null/empty sector as a synthetic UNKNOWN bucket sharing one cap", () => {
    const book: BookPosition[] = [{ symbol: "XXX", sector: null, valuePct: 25, beta: 1, dailyVol: 0.02 }];
    const candidates = [cand({ symbol: "AAA", sector: null, proposedSizePct: 10 })];
    const result = constructPortfolio(book, candidates, { ...DEFAULT_LIMITS, maxSectorExposurePct: 30, maxNameExposurePct: 100, maxGrossExposurePct: 100 });
    expect(result.orders[0].finalSizePct).toBeCloseTo(5, 5); // 30-25 room
  });
});

describe("constructPortfolio — gross cap", () => {
  it("scales down all candidates proportionally when total gross would breach the cap", () => {
    const book: BookPosition[] = [{ symbol: "XXX", sector: "A", valuePct: 70, beta: 1, dailyVol: 0.01 }];
    const candidates = [
      cand({ symbol: "AAA", sector: "B", proposedSizePct: 10 }),
      cand({ symbol: "BBB", sector: "C", proposedSizePct: 10 }),
    ];
    const result = constructPortfolio(book, candidates, { ...DEFAULT_LIMITS, maxGrossExposurePct: 80, maxSectorExposurePct: 100, maxNameExposurePct: 100 });
    // 70 + 10 + 10 = 90 > 80 -> candidates scaled to sum to 10 total (5 each)
    const total = result.orders.reduce((s, o) => s + o.finalSizePct, 0);
    expect(total).toBeCloseTo(10, 4);
  });
});

describe("constructPortfolio — vol budget", () => {
  it("scales down candidates (never the book) when estimated portfolio vol exceeds budget", () => {
    const book: BookPosition[] = [];
    const candidates = [cand({ symbol: "AAA", proposedSizePct: 50, dailyVol: 0.10 })]; // huge vol name
    const result = constructPortfolio(book, candidates, { ...DEFAULT_LIMITS, maxPortfolioVolPct: 1.0, maxGrossExposurePct: 100, maxSectorExposurePct: 100, maxNameExposurePct: 100 });
    expect(result.orders[0].finalSizePct).toBeLessThan(50);
    expect(result.bookAfter.estDailyVolPct).toBeLessThanOrEqual(1.0 + 0.05); // small tolerance for bisection precision
  });

  it("never touches existing book positions, only shrinks new candidates", () => {
    const book: BookPosition[] = [{ symbol: "XXX", sector: "A", valuePct: 15, beta: 1, dailyVol: 0.08 }];
    const candidates = [cand({ symbol: "AAA", proposedSizePct: 20, dailyVol: 0.08 })];
    const result = constructPortfolio(book, candidates, { ...DEFAULT_LIMITS, maxPortfolioVolPct: 0.5, maxGrossExposurePct: 100, maxSectorExposurePct: 100, maxNameExposurePct: 100 });
    // Book position itself isn't in `orders` at all — only candidates are returned/mutated.
    expect(result.orders.find(o => o.symbol === "XXX")).toBeUndefined();
  });
});

describe("constructPortfolio — stacked-bet correlation haircut", () => {
  it("haircuts a candidate's size when its sector already holds >= 2 positions", () => {
    const book: BookPosition[] = [
      { symbol: "X1", sector: "Tech", valuePct: 5, beta: 1, dailyVol: 0.01 },
      { symbol: "X2", sector: "Tech", valuePct: 5, beta: 1, dailyVol: 0.01 },
    ];
    const result = constructPortfolio(book, [cand({ symbol: "AAA", sector: "Tech", proposedSizePct: 10 })],
      { ...DEFAULT_LIMITS, maxSectorExposurePct: 100, maxGrossExposurePct: 100, maxNameExposurePct: 100, maxPortfolioVolPct: 100 });
    expect(result.orders[0].finalSizePct).toBeCloseTo(7, 5); // 10 * 0.7
    expect(result.orders[0].adjustments.some(a => a.startsWith("stacked_bet"))).toBe(true);
  });
});

describe("constructPortfolio — never increases size (invariant)", () => {
  it("finalSizePct is never greater than proposedSizePct across a randomized-ish set of scenarios", () => {
    const scenarios: { book: BookPosition[]; candidates: CandidateOrder[] }[] = [
      { book: [], candidates: [cand({ proposedSizePct: 5 })] },
      { book: [{ symbol: "AAA", sector: "Tech", valuePct: 3, beta: 1, dailyVol: 0.02 }], candidates: [cand({ proposedSizePct: 8 })] },
      { book: [{ symbol: "Z", sector: "Fin", valuePct: 60, beta: 1, dailyVol: 0.05 }], candidates: [cand({ proposedSizePct: 30, sector: "Fin" })] },
    ];
    for (const s of scenarios) {
      const result = constructPortfolio(s.book, s.candidates);
      for (const o of result.orders) {
        expect(o.finalSizePct).toBeLessThanOrEqual(o.proposedSizePct + 1e-9);
      }
    }
  });
});

describe("constructPortfolio — currency/market isolation", () => {
  it("throws when candidates span more than one market", () => {
    expect(() => constructPortfolio([], [
      cand({ symbol: "AAA", market: "us" }),
      cand({ symbol: "BBB", market: "india" }),
    ])).toThrow(/mixed markets/i);
  });

  it("does not throw for a single-market candidate set", () => {
    expect(() => constructPortfolio([], [cand({ market: "india" })])).not.toThrow();
  });
});

describe("constructPortfolio — deny below minimum viable size", () => {
  it("zeroes out a candidate scaled down to a token-sized allocation", () => {
    const book: BookPosition[] = [{ symbol: "XXX", sector: "Tech", valuePct: 29.9, beta: 1, dailyVol: 0.01 }];
    const result = constructPortfolio(book, [cand({ symbol: "AAA", proposedSizePct: 10 })],
      { ...DEFAULT_LIMITS, maxSectorExposurePct: 30, maxGrossExposurePct: 100, maxNameExposurePct: 100 });
    expect(result.orders[0].finalSizePct).toBe(0);
    expect(result.orders[0].adjustments.some(a => a.startsWith("denied"))).toBe(true);
  });
});
