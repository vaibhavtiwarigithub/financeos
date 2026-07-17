import { describe, it, expect } from "vitest";
import {
  allocateSectorBreach,
  SECTOR_BREACH_ALLOCATOR_VERSION,
  type SectorBreachInput,
  type SectorBreachPosition,
} from "@/lib/risk/sector-breach";

// The prod shape that motivated this module: a Technology book at 65.6% of NAV
// against a 30% cap, in the read-only Robinhood account where AVGO sits. hr-v1
// gave EVERY one of these names the identical "Trim" with no size.
//
// NAV = 100_000. Tech = 65_600 (65.6%). One non-Tech name + cash make up the rest.
const TECH: SectorBreachPosition[] = [
  { symbol: "AVGO", sector: "Technology", marketValue: 20_000 }, // 20.0%
  { symbol: "MSFT", sector: "Technology", marketValue: 15_000 }, // 15.0%
  { symbol: "NVDA", sector: "Technology", marketValue: 12_000 }, // 12.0%
  { symbol: "AAPL", sector: "Technology", marketValue: 10_000 }, // 10.0%
  { symbol: "AMD",  sector: "Technology", marketValue:  5_000 }, //  5.0%
  { symbol: "INTC", sector: "Technology", marketValue:  3_600 }, //  3.6%
];
const NON_TECH: SectorBreachPosition[] = [
  { symbol: "JPM", sector: "Financials", marketValue: 10_000 }, // 10.0%
];

const us = (over: Partial<SectorBreachInput> = {}): SectorBreachInput => ({
  positions: [...TECH, ...NON_TECH],
  navValue: 100_000,
  maxSectorExposurePct: 30,
  currency: "USD",
  market: "us",
  ...over,
});

const tech = (r: ReturnType<typeof allocateSectorBreach>) =>
  r.sectors.find(s => s.sector === "Technology")!;

describe("allocateSectorBreach — breach amount (§9.1–2)", () => {
  it("computes the required reduction as sector − cap on the NAV basis", () => {
    // NAV basis: sale proceeds become cash INSIDE NAV, so the denominator does
    // not move and the reduction is exactly 65.6 − 30 = 35.6pp.
    // (The invested basis would give (65.6−30)/(1−0.30) = 50.9pp — a ~43% error.)
    const s = tech(allocateSectorBreach(us()));
    expect(s.breached).toBe(true);
    expect(s.sectorWeightPct).toBeCloseTo(65.6, 6);
    expect(s.requiredReductionPct).toBeCloseTo(35.6, 6);
    expect(s.requiredReductionValue).toBeCloseTo(35_600, 4);
    expect(s.requiredReductionPct).not.toBeCloseTo(50.857, 2); // the invested-basis answer
  });

  it("the allocated trims sum to exactly the required reduction", () => {
    const r = allocateSectorBreach(us());
    const total = TECH.reduce((sum, p) => sum + r.bySymbol.get(p.symbol)!.trimPct, 0);
    expect(total).toBeCloseTo(35.6, 6);
  });

  it("post-trim the sector lands exactly on the cap, and each target = min(w, L)", () => {
    const r = allocateSectorBreach(us());
    const level = tech(r).levelWeightPct!;
    let post = 0;
    for (const p of TECH) {
      const a = r.bySymbol.get(p.symbol)!;
      expect(a.targetWeightPct!).toBeCloseTo(Math.min(a.currentWeightPct, level), 6);
      expect(a.currentWeightPct - a.trimPct).toBeCloseTo(a.targetWeightPct!, 6);
      post += a.targetWeightPct!;
    }
    expect(post).toBeCloseTo(30, 6);
  });

  it("solves the documented water-fill level for the reference book", () => {
    // sorted asc: 3.6, 5, 10, 12, 15, 20. k=2 → L = (30 − 8.6)/4 = 5.35.
    expect(tech(allocateSectorBreach(us())).levelWeightPct!).toBeCloseTo(5.35, 6);
  });
});

describe("allocateSectorBreach — per-name verdicts (§9.5–6): the actual bug", () => {
  it("does NOT give every name in the breached sector the same verdict", () => {
    const r = allocateSectorBreach(us());
    const trims = TECH.map(p => r.bySymbol.get(p.symbol)!.trimPct);
    // hr-v1's blanket trim: every name identical. This must fail on that.
    expect(new Set(trims.map(t => t.toFixed(6))).size).toBeGreaterThan(1);
  });

  it("allocates largest-first: AVGO gives up the most, ranked #1", () => {
    const r = allocateSectorBreach(us());
    const avgo = r.bySymbol.get("AVGO")!;
    expect(avgo.role).toBe("absorb");
    expect(avgo.rank).toBe(1);
    expect(avgo.trimPct).toBeCloseTo(20 - 5.35, 6);
    expect(avgo.targetWeightPct!).toBeCloseTo(5.35, 6);
    expect(tech(r).absorbers).toEqual(["AVGO", "MSFT", "NVDA", "AAPL"]);
  });

  it("names below the fill level are NOT selected — trim 0, role not_selected", () => {
    const r = allocateSectorBreach(us());
    for (const sym of ["AMD", "INTC"]) {
      const a = r.bySymbol.get(sym)!;
      expect(a.role).toBe("not_selected");
      expect(a.trimPct).toBe(0);
      expect(a.trimValue).toBe(0);
      expect(a.targetWeightPct).toBeCloseTo(a.currentWeightPct, 6);
    }
    expect(tech(r).notSelected).toEqual(["AMD", "INTC"]);
  });

  it("a not-selected name says WHY: sector, cap, breach size, and why not it", () => {
    const reason = allocateSectorBreach(us()).bySymbol.get("INTC")!.reason;
    expect(reason).toMatch(/Technology/);
    expect(reason).toMatch(/30% cap/);
    expect(reason).toMatch(/65\.6% of NAV/);
    expect(reason).toMatch(/35\.6pp/);
    expect(reason).toMatch(/not among the names selected to absorb it/i);
    expect(reason).toMatch(/Next:/);
    // It is a HOLD, not a trim.
    expect(reason).toMatch(/^Hold INTC\./);
  });

  it("an absorbing name says WHAT (pp + target + value), WHY, and NEXT", () => {
    const reason = allocateSectorBreach(us()).bySymbol.get("AVGO")!.reason;
    expect(reason).toMatch(/Trim AVGO by 14\.65pp of NAV/);
    expect(reason).toMatch(/from 20\.00% to 5\.35% of NAV/);
    expect(reason).toMatch(/14650 USD/);
    expect(reason).toMatch(/35\.6pp\s+must come out/);
    expect(reason).toMatch(/#1 of the 4 largest/);
    expect(reason).toMatch(/Next:/);
  });

  it("names in a NON-breached sector are no_breach, never asked to absorb", () => {
    const a = allocateSectorBreach(us()).bySymbol.get("JPM")!;
    expect(a.role).toBe("no_breach");
    expect(a.trimPct).toBe(0);
    expect(a.reason).toMatch(/within the 30% sector cap/);
  });
});

describe("allocateSectorBreach — determinism and ties (§9.3–4)", () => {
  const entries = (r: ReturnType<typeof allocateSectorBreach>) =>
    [...r.bySymbol.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  it("is reproducible — same input twice deep-equals", () => {
    expect(entries(allocateSectorBreach(us()))).toEqual(entries(allocateSectorBreach(us())));
    expect(allocateSectorBreach(us()).sectors).toEqual(allocateSectorBreach(us()).sectors);
  });

  it("is independent of input order — shuffling positions changes nothing", () => {
    const shuffled = [...TECH, ...NON_TECH].slice().reverse();
    const a = allocateSectorBreach(us());
    const b = allocateSectorBreach(us({ positions: shuffled }));
    expect(entries(b)).toEqual(entries(a));
    expect(b.sectors).toEqual(a.sectors);
  });

  it("equal weights receive EQUAL trims — no arbitrary winner", () => {
    // Three identical 25% Tech names, 75% sector vs a 30% cap.
    const r = allocateSectorBreach(us({
      positions: [
        { symbol: "BBB", sector: "Technology", marketValue: 25_000 },
        { symbol: "AAA", sector: "Technology", marketValue: 25_000 },
        { symbol: "CCC", sector: "Technology", marketValue: 25_000 },
      ],
    }));
    const trims = ["AAA", "BBB", "CCC"].map(s => r.bySymbol.get(s)!.trimPct);
    expect(trims[0]).toBeCloseTo(trims[1], 9);
    expect(trims[1]).toBeCloseTo(trims[2], 9);
    expect(trims[0]).toBeCloseTo(25 - 10, 6); // level = 30/3 = 10
    // Ordering tie breaks on symbol ascending, deterministically.
    expect(r.sectors[0].absorbers).toEqual(["AAA", "BBB", "CCC"]);
    expect(["AAA", "BBB", "CCC"].map(s => r.bySymbol.get(s)!.rank)).toEqual([1, 2, 3]);
  });

  it("sector summaries order by weight desc then sector asc", () => {
    const r = allocateSectorBreach(us());
    expect(r.sectors.map(s => s.sector)).toEqual(["Technology", "Financials"]);
  });

  it("stamps the allocator version on every allocation", () => {
    const r = allocateSectorBreach(us());
    for (const a of r.bySymbol.values()) expect(a.version).toBe(SECTOR_BREACH_ALLOCATOR_VERSION);
    expect(r.version).toBe(SECTOR_BREACH_ALLOCATOR_VERSION);
  });
});

describe("allocateSectorBreach — sector unknown degrades honestly (§9.16–17)", () => {
  for (const [label, sector] of [["null", null], ["'Other'", "Other"], ["empty", "  "]] as const) {
    it(`${label} sector → role sector_unknown, excluded, never cap-compliant`, () => {
      const r = allocateSectorBreach(us({
        positions: [...TECH, { symbol: "MYSTERY", sector, marketValue: 9_000 }],
      }));
      const a = r.bySymbol.get("MYSTERY")!;
      expect(a.role).toBe("sector_unknown");
      expect(a.sectorWeightPct).toBeNull();
      expect(a.trimPct).toBe(0);
      expect(a.reason).toMatch(/[Ss]ector unknown/);
      expect(a.reason).toMatch(/neither counted toward any sector's breach nor asked to absorb one/);
      expect(a.reason).toMatch(/NOT being treated as cap-compliant/);
      expect(a.role).not.toBe("no_breach");
      expect(r.unknownSectorSymbols).toContain("MYSTERY");
      // Never invented as its own sector.
      expect(r.sectors.map(s => s.sector)).not.toContain("Other");
      expect(r.sectors.map(s => s.sector)).not.toContain(null as any);
    });
  }

  it("an unknown-sector name does not perturb the other names' allocation", () => {
    const withMystery = allocateSectorBreach(us({
      positions: [...TECH, ...NON_TECH, { symbol: "MYSTERY", sector: null, marketValue: 9_000 }],
    }));
    const without = allocateSectorBreach(us());
    for (const p of TECH) {
      expect(withMystery.bySymbol.get(p.symbol)!.trimPct).toBeCloseTo(without.bySymbol.get(p.symbol)!.trimPct, 9);
    }
  });

  it("a book of ONLY unknown-sector names claims no cap-compliance for any of them", () => {
    const r = allocateSectorBreach(us({
      positions: [
        { symbol: "AAA", sector: null, marketValue: 50_000 },
        { symbol: "BBB", sector: "Other", marketValue: 40_000 },
      ],
    }));
    expect(r.sectors).toEqual([]);
    for (const sym of ["AAA", "BBB"]) expect(r.bySymbol.get(sym)!.role).toBe("sector_unknown");
  });

  it("a non-finite / negative market value is unknown, never counted as zero", () => {
    const r = allocateSectorBreach(us({
      positions: [...TECH, { symbol: "BROKEN", sector: "Technology", marketValue: NaN }],
    }));
    expect(r.bySymbol.get("BROKEN")!.role).toBe("sector_unknown");
    expect(r.bySymbol.get("BROKEN")!.reason).toMatch(/no usable market value/);
    // The Technology total is unchanged by the unvalued name.
    expect(tech(r).sectorWeightPct).toBeCloseTo(65.6, 6);
  });
});

describe("allocateSectorBreach — India parity (§9.14–15)", () => {
  // Same weights, INR, `.NS` symbols, India's own sector taxonomy.
  const india = (over: Partial<SectorBreachInput> = {}): SectorBreachInput => ({
    positions: [
      { symbol: "TCS.NS",     sector: "Technology", marketValue: 2_000_000 }, // 20.0%
      { symbol: "INFY.NS",    sector: "Technology", marketValue: 1_500_000 }, // 15.0%
      { symbol: "WIPRO.NS",   sector: "Technology", marketValue: 1_200_000 }, // 12.0%
      { symbol: "HCLTECH.NS", sector: "Technology", marketValue: 1_000_000 }, // 10.0%
      { symbol: "TECHM.NS",   sector: "Technology", marketValue:   500_000 }, //  5.0%
      { symbol: "LTIM.NS",    sector: "Technology", marketValue:   360_000 }, //  3.6%
      { symbol: "HDFCBANK.NS", sector: "Financials", marketValue: 1_000_000 },
    ],
    navValue: 10_000_000,
    maxSectorExposurePct: 30,
    currency: "INR",
    market: "india",
    ...over,
  });

  it("allocates identically to the equal-weight US book — never cross-summed", () => {
    const usR = allocateSectorBreach(us());
    const inR = allocateSectorBreach(india());
    expect(tech(inR).requiredReductionPct).toBeCloseTo(tech(usR).requiredReductionPct, 9);
    expect(tech(inR).levelWeightPct!).toBeCloseTo(tech(usR).levelWeightPct!, 9);
    const pairs: Array<[string, string]> = [
      ["TCS.NS", "AVGO"], ["INFY.NS", "MSFT"], ["WIPRO.NS", "NVDA"],
      ["HCLTECH.NS", "AAPL"], ["TECHM.NS", "AMD"], ["LTIM.NS", "INTC"],
    ];
    for (const [inSym, usSym] of pairs) {
      const a = inR.bySymbol.get(inSym)!;
      const b = usR.bySymbol.get(usSym)!;
      expect(a.trimPct).toBeCloseTo(b.trimPct, 9);
      expect(a.role).toBe(b.role);
      expect(a.rank).toBe(b.rank);
    }
    // Per-currency: the ₹ trim is denominated in ₹ and never mixed with $.
    expect(inR.bySymbol.get("TCS.NS")!.trimValue).toBeCloseTo(1_465_000, 3);
    expect(inR.bySymbol.get("TCS.NS")!.reason).toMatch(/INR/);
    expect(inR.bySymbol.get("TCS.NS")!.reason).not.toMatch(/USD/);
  });

  it("India within cap → no_breach, no US-GICS assumption", () => {
    const r = allocateSectorBreach(india({
      positions: [
        { symbol: "TCS.NS", sector: "Technology", marketValue: 2_000_000 },
        { symbol: "HDFCBANK.NS", sector: "Financials", marketValue: 1_000_000 },
      ],
    }));
    expect(r.sectors.every(s => !s.breached)).toBe(true);
    expect(r.bySymbol.get("TCS.NS")!.role).toBe("no_breach");
  });

  it("an India-only sector label (not in the US map) allocates normally", () => {
    const r = allocateSectorBreach(india({
      positions: [
        { symbol: "RELIANCE.NS", sector: "Oil to Chemicals", marketValue: 5_000_000 },
        { symbol: "ONGC.NS",     sector: "Oil to Chemicals", marketValue: 1_000_000 },
      ],
    }));
    const s = r.sectors.find(x => x.sector === "Oil to Chemicals")!;
    expect(s.breached).toBe(true);
    expect(s.requiredReductionPct).toBeCloseTo(30, 6); // 60% − 30%
    expect(r.bySymbol.get("RELIANCE.NS")!.role).toBe("absorb");
    expect(r.bySymbol.get("ONGC.NS")!.role).toBe("not_selected"); // 10% <= L = 20%
  });
});

describe("allocateSectorBreach — degenerate inputs never fabricate a breach (§9.21)", () => {
  for (const cap of [0, -5, 100, 150, NaN, Infinity]) {
    it(`cap ${String(cap)} → no_breach, no fabricated reduction`, () => {
      const r = allocateSectorBreach(us({ maxSectorExposurePct: cap }));
      expect(r.sectors.every(s => !s.breached)).toBe(true);
      expect(r.sectors.every(s => s.requiredReductionPct === 0)).toBe(true);
      expect(r.bySymbol.get("AVGO")!.role).toBe("no_breach");
      expect(r.bySymbol.get("AVGO")!.trimPct).toBe(0);
    });
  }

  for (const nav of [0, -1, NaN, Infinity]) {
    it(`NAV ${String(nav)} → every name sector_unknown (no weight is computable)`, () => {
      const r = allocateSectorBreach(us({ navValue: nav }));
      expect(r.sectors).toEqual([]);
      expect(r.bySymbol.get("AVGO")!.role).toBe("sector_unknown");
      expect(r.bySymbol.get("AVGO")!.reason).toMatch(/NAV is unavailable/);
    });
  }

  it("empty book → empty result", () => {
    const r = allocateSectorBreach(us({ positions: [] }));
    expect(r.sectors).toEqual([]);
    expect(r.bySymbol.size).toBe(0);
  });

  it("a sector exactly AT the cap is not breached", () => {
    const r = allocateSectorBreach(us({
      positions: [{ symbol: "AAA", sector: "Technology", marketValue: 30_000 }],
    }));
    expect(tech(r).breached).toBe(false);
    expect(r.bySymbol.get("AAA")!.role).toBe("no_breach");
  });

  it("a single name IS the whole breached sector → it absorbs all of it", () => {
    const r = allocateSectorBreach(us({
      positions: [{ symbol: "AAA", sector: "Technology", marketValue: 65_600 }],
    }));
    const a = r.bySymbol.get("AAA")!;
    expect(a.role).toBe("absorb");
    expect(a.trimPct).toBeCloseTo(35.6, 6);
    expect(a.targetWeightPct!).toBeCloseTo(30, 6);
    expect(a.absorberCount).toBe(1);
    expect(a.reason).toMatch(/#1 of the 1 largest Technology position\b/);
  });
});
