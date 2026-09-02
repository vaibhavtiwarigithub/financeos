import { describe, expect, it } from "vitest";
import {
  classifySector, canonicalSectorKey, sectorCoverage, GICS_SECTORS,
} from "@/lib/scoring/sector-taxonomy";

// Stage 0 of features/sector-regime-dimension.
//
// Measured 2026-09-02 across symbol_profiles, paper_positions and
// holding_risk_snapshots: 41 distinct sector strings at MIXED granularity, with
// a median of ~2 symbols per label. rank.ts groups on
// market x asset-type x sector and needs RANK_MIN_GROUP_EQUITY_US = 20 members,
// so essentially every sector group fell under the floor and collapsed into the
// market-wide fallback — the cross-sectional rank gate would have ranked against
// the whole market while presenting a sector-partitioned design.

describe("mixed granularity collapses to one GICS level", () => {
  it("lifts INDUSTRY labels to their sector — the fragmentation that broke grouping", () => {
    // Each pair was a SEPARATE group before, splitting an already-thin universe.
    expect(canonicalSectorKey("Semiconductors")).toBe("Information Technology");
    expect(canonicalSectorKey("Technology")).toBe("Information Technology");
    expect(canonicalSectorKey("Banking")).toBe("Financials");
    expect(canonicalSectorKey("Financial Services")).toBe("Financials");
    expect(canonicalSectorKey("Biotechnology")).toBe("Health Care");
    expect(canonicalSectorKey("Road & Rail")).toBe("Industrials");
    expect(canonicalSectorKey("Aerospace & Defense")).toBe("Industrials");
    expect(canonicalSectorKey("Metals & Mining")).toBe("Materials");
  });

  it("collapses the three names for Communication Services", () => {
    for (const raw of ["Communications", "Communication", "Telecommunication", "Media"]) {
      expect(canonicalSectorKey(raw)).toBe("Communication Services");
    }
  });

  it("accepts the Yahoo naming used elsewhere in the codebase", () => {
    expect(canonicalSectorKey("Consumer Cyclical")).toBe("Consumer Discretionary");
    expect(canonicalSectorKey("Consumer Defensive")).toBe("Consumer Staples");
    expect(canonicalSectorKey("Basic Materials")).toBe("Materials");
  });

  it("is case and whitespace insensitive", () => {
    expect(canonicalSectorKey("  sEmIcOnDuCtOrS  ")).toBe("Information Technology");
  });

  it("only ever emits one of the 11 GICS sectors for equities", () => {
    const equityLabels = ["Technology", "Semiconductors", "Banking", "Media", "Retail", "Chemicals"];
    for (const raw of equityLabels) {
      const result = classifySector(raw);
      expect(result.kind).toBe("gics");
      if (result.kind === "gics") expect(GICS_SECTORS).toContain(result.sector);
    }
  });
});

describe("fund asset classes are NOT bent into equity sectors", () => {
  it("keeps bond, commodity and crypto funds out of GICS", () => {
    // holding_risk_snapshots carries these alongside real sectors. Mapping a
    // bond ETF into a GICS sector is a category error: it would put it in a peer
    // group of operating companies.
    for (const [raw, expected] of [
      ["Fixed Income", "Fixed Income"],
      ["Commodities", "Commodities"],
      ["Digital Assets", "Digital Assets"],
      ["Diversified Equity", "Diversified Equity"],
      ["International Equity", "International Equity"],
    ] as const) {
      const result = classifySector(raw);
      expect(result.kind).toBe("fund_asset_class");
      if (result.kind === "fund_asset_class") expect(result.assetClass).toBe(expected);
    }
  });
});

describe("unknown labels are never guessed", () => {
  it("returns unmapped for 'Other', empty and unrecognised labels", () => {
    // A WRONG sector is worse than a missing one: it places a symbol in a peer
    // group it does not belong to, and every relative comparison inside that
    // group is then quietly wrong. rank.ts already has a market-wide fallback.
    for (const raw of ["Other", "", "   ", null, undefined, "Blockchain Synergy"]) {
      expect(classifySector(raw).kind).toBe("unmapped");
      expect(canonicalSectorKey(raw)).toBeNull();
    }
  });

  it("preserves the raw label so the gap is fixable", () => {
    const result = classifySector("Blockchain Synergy");
    expect(result.kind).toBe("unmapped");
    if (result.kind === "unmapped") expect(result.raw).toBe("Blockchain Synergy");
  });
});

describe("coverage is measured, not assumed", () => {
  it("counts gics, fund and unmapped separately", () => {
    const result = sectorCoverage([
      "Technology", "Semiconductors", "Banking",   // 3 gics
      "Fixed Income",                               // 1 fund
      "Other", null, "Blockchain Synergy",          // 3 unmapped
    ]);
    expect(result.total).toBe(7);
    expect(result.gics).toBe(3);
    expect(result.fundAssetClass).toBe(1);
    expect(result.unmapped).toBe(3);
    expect(result.mapped).toBe(4);
    expect(result.coverage).toBeCloseTo(4 / 7, 10);
  });

  it("names the unmapped labels, most frequent first", () => {
    const result = sectorCoverage(["Widgets", "Widgets", "Gizmos", "Technology"]);
    expect(result.unmappedLabels[0]).toEqual({ label: "Widgets", count: 2 });
    expect(result.unmappedLabels[1]).toEqual({ label: "Gizmos", count: 1 });
  });

  it("reports zero coverage on an empty population without dividing by zero", () => {
    const result = sectorCoverage([]);
    expect(result.coverage).toBe(0);
    expect(Number.isFinite(result.coverage)).toBe(true);
  });
});

describe("every label observed in production on 2026-09-02 resolves", () => {
  it("maps or explicitly classifies all 41 stored labels", () => {
    // The full observed label set. A new provider label appearing here as
    // unmapped is a one-line map entry, not another investigation — which is the
    // point of keeping this list explicit.
    const observed = [
      "Technology", "Diversified Equity", "Other", "Financials", "International Equity",
      "Consumer Discretionary", "Energy", "Industrials", "Digital Assets", "Healthcare",
      "Commodities", "Materials", "Fixed Income", "Communication", "Consumer Staples",
      "Utilities", "Semiconductors", "Real Estate", "Financial Services",
      "Hotels, Restaurants & Leisure", "Retail", "Media", "Telecommunication",
      "Consumer Cyclical", "Electrical Equipment", "Communications", "Metals & Mining",
      "Banking", "Road & Rail", "Aerospace & Defense", "Consumer products",
      "Biotechnology", "Automobiles", "Communication Services", "Chemicals",
      "Commercial Services & Supplies", "Beverages", "Life Sciences Tools & Services",
      "Logistics & Transportation", "Machinery", "Basic Materials",
    ];
    expect(observed).toHaveLength(41);
    const coverage = sectorCoverage(observed);
    // "Other" is the ONLY label that legitimately resolves to nothing.
    expect(coverage.unmappedLabels).toEqual([{ label: "Other", count: 1 }]);
    expect(coverage.mapped).toBe(40);
  });
});
