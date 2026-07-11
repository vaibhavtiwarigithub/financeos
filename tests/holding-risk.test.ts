import { describe, it, expect } from "vitest";
import {
  computeHoldingRisk,
  HOLDING_RISK_FORMULA_VERSION,
  type HoldingRiskInput,
  type HoldingRiskContext,
  type HoldingRiskLimits,
} from "@/lib/risk/holding-risk";

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

  it("name breach at/over the cap yields a trim posture", () => {
    const r = computeHoldingRisk(holding({ marketValue: 1300 }), fullCtx({ accountTotalValue: 10000, sectorWeightPct: 0.13 }));
    expect(r.riskPosture).toBe("trim");
    expect(r.actionReason).toMatch(/name/i);
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

  it("full 20 points when the sector sits exactly at its cap", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ sectorWeightPct: 0.30 }));
    expect(r.drivers.find(d => d.component === "sector_concentration")!.points).toBeCloseTo(20, 5);
  });

  it("sector breach contributes a trim posture", () => {
    const r = computeHoldingRisk(holding(), fullCtx({ sectorWeightPct: 0.31 }));
    expect(r.riskPosture).toBe("trim");
    expect(r.actionReason).toMatch(/sector/i);
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

  it("high corr with material cluster weight triggers a trim (cluster breach)", () => {
    const r = computeHoldingRisk(holding(), fullCtx({
      clusterAvgCorr: 0.9, clusterWeightPct: 0.30, clusterPeers: ["BBB", "CCC"],
    }));
    expect(r.riskPosture).toBe("trim");
    expect(r.actionReason).toMatch(/correlated cluster/i);
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
