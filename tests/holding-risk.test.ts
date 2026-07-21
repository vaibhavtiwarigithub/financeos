import { describe, it, expect } from "vitest";
import {
  computeHoldingRisk,
  HOLDING_RISK_FORMULA_VERSION,
  type HoldingRiskInput,
  type HoldingRiskContext,
  type HoldingRiskLimits,
} from "@/lib/risk/holding-risk";
import {
  allocateSectorBreach,
  SECTOR_BREACH_ALLOCATOR_VERSION,
  type SectorBreachAllocation,
  type BreachRole,
} from "@/lib/risk/sector-breach";

// A hand-built allocation for a given role. The allocator's own arithmetic is
// proven in tests/sector-breach.test.ts; here we only prove how the POSTURE
// consumes a role.
const allocOf = (role: BreachRole, over: Partial<SectorBreachAllocation> = {}): SectorBreachAllocation => ({
  symbol: "AAA", sector: "Technology", role,
  sectorWeightPct: 65.6, capPct: 30,
  currentWeightPct: 10, targetWeightPct: role === "absorb" ? 5.35 : 10,
  trimPct: role === "absorb" ? 4.65 : 0,
  trimValue: role === "absorb" ? 465 : 0,
  rank: role === "absorb" ? 1 : null,
  absorberCount: role === "absorb" ? 4 : 4,
  reason: role === "absorb"
    ? "Trim AAA by 4.65pp of NAV — from 10.00% to 5.35% of NAV (≈ 465 USD). Why: Technology is 65.6% of NAV against the 30% cap, so 35.6pp must come out of the sector; AAA is #1 of the 4 largest Technology positions. Next: re-check after the reduction."
    : "Hold AAA. Why: Technology IS over its 30% cap (65.6% of NAV) and 35.6pp must come out of the sector — but AAA is not among the names selected to absorb it. Next: AAA only becomes a candidate if those larger positions are not reduced.",
  version: SECTOR_BREACH_ALLOCATOR_VERSION,
  ...over,
});

// Owner-approved reference limits (percent units, corr 0–1).
const LIMITS: HoldingRiskLimits = {
  maxNameExposurePct: 12,
  maxSectorExposurePct: 30,
  maxPortfolioVolPct: 2.0,
  maxAvgPairwiseCorr: 0.7,
  maxGrossExposurePct: 80,
};

const holding = (over: Partial<HoldingRiskInput> = {}): HoldingRiskInput => ({
  symbol: "AAA", qty: 10, currentPrice: 100, marketValue: 1000,
  averageCost: 100, unrealizedPnlPct: 0, sector: "Technology", beta: 1, realizedVolPct: 2, ...over,
});

// A ctx with every optional dimension present (full confidence), all benign.
const fullCtx = (over: Partial<HoldingRiskContext> = {}): HoldingRiskContext => ({
  accountTotalValue: 10000, currency: "USD", limits: LIMITS, quoteFresh: true,
  readOnlyAccount: false,
  sectorWeightPct: 0.10, grossExposurePct: 0.5,
  clusterAvgCorr: 0.2, clusterPeers: [], clusterWeightPct: 0.10,
  stopDistancePct: 0.20, protectiveStopHit: false, thesisBreak: false,
  hasFreshEventData: true, eventFlag: null, liquidityFlag: null, ...over,
});

describe("computeHoldingRisk — structural gate", () => {
  for (const [field, patch] of [
    ["qty", { qty: null }],
    ["current_price", { currentPrice: null }],
    ["market_value", { marketValue: null }],
  ] as const) {
    it(`returns insufficient_data when ${field} is missing`, () => {
      const r = computeHoldingRisk(holding(patch as Partial<HoldingRiskInput>), fullCtx());
      expect(r.score).toBeNull();
      expect(r.riskPosture).toBe("insufficient_data");
      expect(r.missingInputs).toContain(field);
    });
  }

  it("insufficient_data when account total is zero/nonpositive", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ accountTotalValue: 0 }));
    expect(r.score).toBeNull();
    expect(r.missingInputs).toContain("account_total_value");
  });

  it("insufficient_data when currency is neither USD nor INR", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ currency: null }));
    expect(r.missingInputs).toContain("currency");
  });

  it("stale quote forces insufficient_data (no actionable posture)", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ quoteFresh: false }));
    expect(r.score).toBeNull();
    expect(r.missingInputs).toContain("stale_quote");
  });

  it("rejects NaN / Infinity structural inputs", () => {
    expect(computeHoldingRisk(holding({ marketValue: NaN }), fullCtx()).score).toBeNull();
    expect(computeHoldingRisk(holding({ currentPrice: Infinity }), fullCtx()).score).toBeNull();
    expect(computeHoldingRisk(holding({ qty: -Infinity }), fullCtx()).score).toBeNull();
    expect(computeHoldingRisk(holding(), fullCtx({ accountTotalValue: NaN })).score).toBeNull();
  });
});

describe("computeHoldingRisk — name concentration (30 cap)", () => {
  it("scores 0 name points at 0% weight and full 30 at/over the cap", () => {
    // weight = mv / total. 12% weight == name cap (12%) → full 30.
    const atCap = computeHoldingRisk(holding({ marketValue: 1200 }), fullCtx({ accountTotalValue: 10000, sectorWeightPct: 0.12 }));
    const nameDriver = atCap.drivers.find(d => d.component === "name_concentration")!;
    expect(nameDriver.points).toBeCloseTo(30, 5);
    expect(nameDriver.utilization).toBeCloseTo(1, 5);

    const half = computeHoldingRisk(holding({ marketValue: 600 }), fullCtx());
    expect(half.drivers.find(d => d.component === "name_concentration")!.points).toBeCloseTo(15, 5);
  });

  it("clamps name points at the cap when weight exceeds the limit", () => {
    const over = computeHoldingRisk(holding({ marketValue: 5000 }), fullCtx({ accountTotalValue: 10000, sectorWeightPct: 0.5 }));
    expect(over.drivers.find(d => d.component === "name_concentration")!.points).toBeCloseTo(30, 5);
  });

  it("name breach at/over the global reference yields review, not a sell instruction", () => {
    const r = computeHoldingRisk(holding({ marketValue: 1300 }), fullCtx({ accountTotalValue: 10000, sectorWeightPct: 0.13 }));
    expect(r.riskPosture).toBe("review");
    expect(r.actionReason).toMatch(/name/i);
    expect(r.actionReason).toMatch(/no trim is recommended/i);
  });
});

describe("computeHoldingRisk — sector concentration (20 cap), missing-dim confidence", () => {
  it("excludes sector when sector is 'Other' or weight missing, and lists it missing", () => {
    const r = computeHoldingRisk(holding({ sector: "Other" }), fullCtx());
    const d = r.drivers.find(x => x.component === "sector_concentration")!;
    expect(d.points).toBe(0);
    expect(d.utilization).toBeNull();
    expect(r.missingInputs).toContain("sector_exposure");
  });

  it("does not apply an equity-sector cap to broad asset-class exposures", () => {
    for (const sector of ["Diversified Equity", "International Equity", "Fixed Income", "Commodities", "Digital Assets"]) {
      const r = computeHoldingRisk(holding({ sector }), fullCtx({ sectorWeightPct: 0.80 }));
      const d = r.drivers.find(x => x.component === "sector_concentration")!;
      expect(d.points, sector).toBe(0);
      expect(d.utilization, sector).toBeNull();
      expect(r.riskPosture, sector).not.toBe("trim");
    }
  });

  it("full 20 points when the sector sits exactly at its cap", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ sectorWeightPct: 0.30 }));
    expect(r.drivers.find(d => d.component === "sector_concentration")!.points).toBeCloseTo(20, 5);
  });

  it("sector allocation quantifies exposure but remains review-only", () => {
    const r = computeHoldingRisk(holding(), fullCtx({
      sectorWeightPct: 0.31,
      sectorBreachAllocation: allocOf("absorb"),
    }));
    expect(r.riskPosture).toBe("review");
    expect(r.actionReason).toMatch(/sector/i);
  });
});

// ── The defect: a sector-cap breach is a SECTOR property with no per-name
// allocation, so hr-v1 gave EVERY holding in the sector the identical "trim".
// hr-v2 makes it a per-name verdict via the deterministic allocator.
// Spec: features/risk-sector-breach-allocation/FEATURE_ARCHITECTURE.md §6, §9.
describe("computeHoldingRisk — sector breach is allocated, not blanket (hr-v3)", () => {
  const breachedCtx = (over: Partial<HoldingRiskContext> = {}) =>
    fullCtx({ sectorWeightPct: 0.656, ...over });

  it("selected to absorb is review-only and exposes no simulated sell quantity", () => {
    const r = computeHoldingRisk(holding(), breachedCtx({ sectorBreachAllocation: allocOf("absorb") }));
    expect(r.riskPosture).toBe("review");
    expect(r.actionReason).toMatch(/contributes materially/i);
    expect(r.actionReason).toMatch(/no trim is recommended/i);
    expect(r.actionReason).not.toMatch(/4\.65pp|5\.35%|#1 of/);
  });

  it("NOT selected → hold, and the hold says WHY (§9.11)", () => {
    const r = computeHoldingRisk(holding(), breachedCtx({ sectorBreachAllocation: allocOf("not_selected") }));
    expect(r.riskPosture).toBe("hold");
    // The generic hold string would be a LIE while the sector is over its cap.
    expect(r.actionReason).not.toMatch(/within owner-approved risk limits/);
    expect(r.actionReason).toMatch(/Technology IS over its 30% cap/);
    expect(r.actionReason).toMatch(/not among the names selected to absorb it/);
    expect(r.actionReason).toMatch(/Next:/);
  });

  it("the SAME sector breach yields DIFFERENT verdicts for different names (§9.6)", () => {
    const absorb = computeHoldingRisk(holding({ symbol: "AVGO" }), breachedCtx({
      sectorBreachAllocation: allocOf("absorb", { symbol: "AVGO" }),
    }));
    const held = computeHoldingRisk(holding({ symbol: "INTC" }), breachedCtx({
      sectorBreachAllocation: allocOf("not_selected", { symbol: "INTC" }),
    }));
    // hr-v1 returned "trim" for both off the identical sector number.
    expect(absorb.riskPosture).toBe("review");
    expect(held.riskPosture).toBe("hold");
    expect(absorb.actionReason).not.toEqual(held.actionReason);
  });

  it("sector breached with NO allocation → review, never a blanket trim (§9.9)", () => {
    const r = computeHoldingRisk(holding(), breachedCtx({ sectorBreachAllocation: null }));
    expect(r.riskPosture).toBe("review");
    expect(r.riskPosture).not.toBe("trim");
    expect(r.missingInputs).toContain("sector_breach_allocation");
    expect(r.actionReason).toMatch(/cannot say whether AAA is one of the names/);
  });

  it("an allocation contradicting the sector driver is not trusted → review", () => {
    // `no_breach` / `sector_unknown` while sectorUtil >= 1 means the caller's
    // sectorWeightPct and the allocator disagree (e.g. a denominator mismatch).
    for (const role of ["no_breach", "sector_unknown"] as const) {
      const r = computeHoldingRisk(holding(), breachedCtx({ sectorBreachAllocation: allocOf(role) }));
      expect(r.riskPosture).toBe("review");
      expect(r.missingInputs).toContain("sector_breach_allocation");
    }
  });

  it("records the allocation in the sector driver's evidence trail", () => {
    const absorb = computeHoldingRisk(holding(), breachedCtx({ sectorBreachAllocation: allocOf("absorb") }));
    expect(absorb.drivers.find(d => d.component === "sector_concentration")!.detail)
      .toMatch(/selected to absorb 4\.65pp \(#1 of 4\)/);
    const held = computeHoldingRisk(holding(), breachedCtx({ sectorBreachAllocation: allocOf("not_selected") }));
    expect(held.drivers.find(d => d.component === "sector_concentration")!.detail)
      .toMatch(/NOT selected to absorb the breach/);
  });

  it("the allocation never suppresses a different limit's breach (§9.12–13)", () => {
    // Name cap breached (13% > 12%) while the sector allocator says not_selected.
    const name = computeHoldingRisk(holding({ marketValue: 1300 }), breachedCtx({
      accountTotalValue: 10000, sectorBreachAllocation: allocOf("not_selected"),
    }));
    expect(name.riskPosture).toBe("review");
    expect(name.actionReason).toMatch(/name weight 13\.0% exceeds the 12% global Kairos trading reference/);

    // Correlation identifies overlap, but without a per-name quantity allocator
    // it can only request review, never a blanket trim.
    const cluster = computeHoldingRisk(holding(), breachedCtx({
      clusterAvgCorr: 0.9, clusterWeightPct: 0.30, clusterPeers: ["BBB"],
      sectorBreachAllocation: allocOf("not_selected"),
    }));
    expect(cluster.riskPosture).toBe("review");
    expect(cluster.actionReason).toMatch(/correlated cluster/i);
  });

  it("stays pure — the allocation does not make the result order-dependent", () => {
    const ctx = () => breachedCtx({ sectorBreachAllocation: allocOf("absorb") });
    expect(computeHoldingRisk(holding(), ctx())).toEqual(computeHoldingRisk(holding(), ctx()));
  });
});

// The one property the allocator must never touch: a risk-driven exit.
// Same invariant as lib/evidence/degradation-guard.ts (§6.5 there).
describe("computeHoldingRisk — an exit is NEVER suppressed by an allocation (§9.7–8)", () => {
  for (const role of ["absorb", "not_selected", "no_breach", "sector_unknown"] as const) {
    it(`protective stop + role '${role}' → still exit_review`, () => {
      const r = computeHoldingRisk(holding(), fullCtx({
        sectorWeightPct: 0.656, protectiveStopHit: true, sectorBreachAllocation: allocOf(role),
      }));
      expect(r.riskPosture).toBe("exit_review");
      expect(r.actionReason).toMatch(/protective stop breached/);
    });

    it(`thesis break + role '${role}' → still exit_review`, () => {
      const r = computeHoldingRisk(holding(), fullCtx({
        sectorWeightPct: 0.656, thesisBreak: true, sectorBreachAllocation: allocOf(role),
      }));
      expect(r.riskPosture).toBe("exit_review");
    });
  }

  it("no allocation at all cannot delay an exit either", () => {
    const r = computeHoldingRisk(holding(), fullCtx({
      sectorWeightPct: 0.656, protectiveStopHit: true, sectorBreachAllocation: null,
    }));
    expect(r.riskPosture).toBe("exit_review");
  });

  it("unrealized loss ALONE still never triggers exit_review, allocation or not", () => {
    const r = computeHoldingRisk(holding({ unrealizedPnlPct: -0.40 }), fullCtx({
      sectorWeightPct: 0.656, sectorBreachAllocation: allocOf("absorb"),
    }));
    expect(r.riskPosture).not.toBe("exit_review");
  });
});

describe("computeHoldingRisk - concentration remains advisory", () => {
  it("a read-only account says the app cannot trade it", () => {
    const trim = computeHoldingRisk(holding(), fullCtx({
      sectorWeightPct: 0.656, readOnlyAccount: true, sectorBreachAllocation: allocOf("absorb"),
    }));
    expect(trim.riskPosture).toBe("review");
    expect(trim.actionReason).toMatch(/no trim is recommended/i);
    expect(trim.actionReason).toMatch(/Advisory only — this account is read-only in Kairos; the app cannot trade it\./);

    const exit = computeHoldingRisk(holding(), fullCtx({ readOnlyAccount: true, protectiveStopHit: true }));
    expect(exit.actionReason).toMatch(/read-only in Kairos/);
  });

  it("the order-permitted account still says no order is placed by this feature", () => {
    const r = computeHoldingRisk(holding(), fullCtx({
      sectorWeightPct: 0.656, readOnlyAccount: false, sectorBreachAllocation: allocOf("absorb"),
    }));
    expect(r.riskPosture).toBe("review");
    expect(r.actionReason).toMatch(/no trim is recommended/i);
    expect(r.actionReason).toMatch(/this feature places no order/);
    expect(r.actionReason).toMatch(/requires owner approval in the Execution Gateway/);
  });

  it("an absent flag defaults to the read-only wording (honest default)", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ readOnlyAccount: undefined, protectiveStopHit: true }));
    expect(r.actionReason).toMatch(/read-only in Kairos/);
  });
});

// End-to-end over the REAL allocator: the exact book from the prod defect.
describe("computeHoldingRisk × allocateSectorBreach — the AVGO defect (end to end)", () => {
  const NAV = 100_000;
  const BOOK = [
    { symbol: "AVGO", sector: "Technology", marketValue: 20_000 },
    { symbol: "MSFT", sector: "Technology", marketValue: 15_000 },
    { symbol: "NVDA", sector: "Technology", marketValue: 12_000 },
    { symbol: "AAPL", sector: "Technology", marketValue: 10_000 },
    { symbol: "AMD",  sector: "Technology", marketValue:  5_000 },
    { symbol: "INTC", sector: "Technology", marketValue:  3_600 },
  ];

  const verdicts = () => {
    const breach = allocateSectorBreach({
      positions: BOOK, navValue: NAV, maxSectorExposurePct: 30, currency: "USD", market: "us",
    });
    return new Map(BOOK.map(p => [p.symbol, computeHoldingRisk(
      { symbol: p.symbol, qty: 1, currentPrice: p.marketValue, marketValue: p.marketValue,
        sector: p.sector, beta: 1, realizedVolPct: 2, unrealizedPnlPct: 0 },
      { accountTotalValue: NAV, currency: "USD", limits: LIMITS, quoteFresh: true,
        sectorWeightPct: 0.656, grossExposurePct: 0.656,
        clusterAvgCorr: 0.2, clusterPeers: [], clusterWeightPct: 0.1,
        stopDistancePct: 0.2, protectiveStopHit: false, thesisBreak: false,
        hasFreshEventData: true, eventFlag: null, liquidityFlag: null,
        readOnlyAccount: true, // account 965848641
        sectorBreachAllocation: breach.bySymbol.get(p.symbol)!,
      },
    )]));
  };

  it("no longer gives every Technology name the identical Trim verdict", () => {
    const v = verdicts();
    const reasons = new Set([...v.values()].map(r => r.actionReason));
    expect(reasons.size).toBe(BOOK.length); // hr-v1: all six identical
    expect([...v.values()].every(r => r.riskPosture === "trim")).toBe(false);
  });

  it("AVGO exposes the simulated reduction but a read-only account is not told to trade", () => {
    const r = verdicts().get("AVGO")!;
    expect(r.riskPosture).toBe("review");
    expect(r.actionReason).toMatch(/contributes materially/i);
    expect(r.actionReason).not.toMatch(/14\.65pp/);
    expect(r.actionReason).toMatch(/no trim is recommended/i);
    expect(r.actionReason).toMatch(/read-only in Kairos/);
  });

  it("INTC holds — and is told exactly why it was not selected", () => {
    const r = verdicts().get("INTC")!;
    expect(r.riskPosture).toBe("hold");
    expect(r.actionReason).toMatch(/Technology IS over its 30% cap \(65\.6% of NAV\)/);
    expect(r.actionReason).toMatch(/INTC is not among the names selected to absorb it/);
  });

  it("is reproducible end to end", () => {
    expect([...verdicts().entries()]).toEqual([...verdicts().entries()]);
  });
});

describe("computeHoldingRisk — volatility/beta (15 cap), real evidence only", () => {
  it("excludes vol/beta when neither is present", () => {
    const r = computeHoldingRisk(holding({ realizedVolPct: null, beta: null }), fullCtx());
    const d = r.drivers.find(x => x.component === "volatility_beta")!;
    expect(d.points).toBe(0);
    expect(r.missingInputs).toContain("volatility_beta");
  });

  it("saturates vol points at the name-vol reference (4%)", () => {
    const r = computeHoldingRisk(holding({ realizedVolPct: 4, beta: null }), fullCtx());
    expect(r.drivers.find(d => d.component === "volatility_beta")!.points).toBeCloseTo(15, 5);
  });

  it("uses the max of vol and beta-excess", () => {
    // beta 2.0 → full excess; vol 0 → 0. Max → full 15.
    const r = computeHoldingRisk(holding({ realizedVolPct: 0, beta: 2 }), fullCtx());
    expect(r.drivers.find(d => d.component === "volatility_beta")!.points).toBeCloseTo(15, 5);
  });
});

describe("computeHoldingRisk — correlated cluster (15 cap), computed corr", () => {
  it("excludes correlation when clusterAvgCorr is null (never assumes zero)", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ clusterAvgCorr: null }));
    const d = r.drivers.find(x => x.component === "correlated_cluster")!;
    expect(d.points).toBe(0);
    expect(r.missingInputs).toContain("correlation");
  });

  it("high corr with material cluster weight triggers review, not an unallocated trim", () => {
    const r = computeHoldingRisk(holding(), fullCtx({
      clusterAvgCorr: 0.9, clusterWeightPct: 0.30, clusterPeers: ["BBB", "CCC"],
    }));
    expect(r.riskPosture).toBe("review");
    expect(r.actionReason).toMatch(/correlated cluster/i);
    expect(r.actionReason).toMatch(/does not identify which holding or quantity to sell/i);
  });

  it("high corr but immaterial cluster weight does NOT breach", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ clusterAvgCorr: 0.9, clusterWeightPct: 0.02 }));
    expect(r.riskPosture).not.toBe("trim");
  });
});

describe("computeHoldingRisk — posture precedence", () => {
  it("protective stop hit → exit_review (over any concentration breach)", () => {
    const r = computeHoldingRisk(holding({ marketValue: 5000 }), fullCtx({ accountTotalValue: 10000, sectorWeightPct: 0.5, protectiveStopHit: true }));
    expect(r.riskPosture).toBe("exit_review");
    expect(r.actionReason).toMatch(/protective stop/i);
  });

  it("thesis break → exit_review", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ thesisBreak: true }));
    expect(r.riskPosture).toBe("exit_review");
  });

  it("unrealized loss ALONE never triggers exit_review (loss-chasing guard)", () => {
    const r = computeHoldingRisk(holding({ unrealizedPnlPct: -0.40 }), fullCtx({ protectiveStopHit: false, thesisBreak: false }));
    expect(r.riskPosture).not.toBe("exit_review");
  });

  it("low confidence (partial data) → review", () => {
    // Strip every optional dimension → confidence stays at base 0.2 < 0.5.
    const bare: HoldingRiskContext = {
      accountTotalValue: 10000, currency: "USD", limits: LIMITS, quoteFresh: true,
    };
    const r = computeHoldingRisk(holding({ sector: "Other", beta: null, realizedVolPct: null, unrealizedPnlPct: null }), bare);
    expect(r.dataConfidence).toBeLessThan(0.5);
    expect(r.riskPosture).toBe("review");
  });

  it("benign, fully-confident holding → hold with add_capacity", () => {
    const r = computeHoldingRisk(holding({ marketValue: 500 }), fullCtx());
    expect(r.riskPosture).toBe("hold");
    expect(r.dataConfidence).toBeGreaterThanOrEqual(0.5);
    expect(r.addCapacity).toBe(true);
  });

  it("add_capacity is false when a name breach exists", () => {
    const r = computeHoldingRisk(holding({ marketValue: 1300 }), fullCtx({ accountTotalValue: 10000, sectorWeightPct: 0.13 }));
    expect(r.addCapacity).toBe(false);
  });
});

describe("computeHoldingRisk — score bounds and metadata", () => {
  it("score is an integer clamped to [0,100]", () => {
    const r = computeHoldingRisk(holding({ marketValue: 5000, realizedVolPct: 8, beta: 3, unrealizedPnlPct: -0.5 }), fullCtx({
      accountTotalValue: 10000, sectorWeightPct: 0.5, clusterAvgCorr: 0.95, clusterWeightPct: 0.5,
      stopDistancePct: 0,
      hasFreshEventData: true, eventFlag: { kind: "earnings", detail: "tmrw" }, liquidityFlag: { kind: "thin", detail: "low ADV" },
    }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(r.score)).toBe(true);
  });

  it("stamps the formula version", () => {
    expect(computeHoldingRisk(holding(), fullCtx()).formulaVersion).toBe(HOLDING_RISK_FORMULA_VERSION);
  });

  it("is pure — identical inputs give identical output", () => {
    const a = computeHoldingRisk(holding(), fullCtx());
    const b = computeHoldingRisk(holding(), fullCtx());
    expect(a).toEqual(b);
  });
});
