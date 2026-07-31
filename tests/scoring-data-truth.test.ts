import { describe, expect, it } from "vitest";
import {
  MAX_SCORABLE_PE,
  hasMinFundamentalFields,
  normalizeInsiderScore,
  resolveSectorPeBenchmark,
  scoreFundamentals,
} from "@/lib/data/scores";

describe("fundamental provider taxonomy contract", () => {
  it("crosswalks Finnhub Semiconductors to the Technology benchmark", () => {
    expect(resolveSectorPeBenchmark("Semiconductors", "finnhub_industry")).toEqual({
      norm: 30, normalizedSector: "technology", mappingStatus: "crosswalk",
    });
    const result = scoreFundamentals({
      Symbol: "TSM", Sector: "Semiconductors",
      SectorTaxonomy: "finnhub_industry", PERatio: "25",
    }, false);
    expect(result.score).toBe(58);
    expect(result.evidence).toMatchObject({
      pe_scoring_status: "applied", pe_sector_norm: 30,
      pe_normalized_sector: "technology",
    });
  });

  it("does not silently assign P/E 20 to an unmapped industry", () => {
    const result = scoreFundamentals({
      Symbol: "SHOP", Sector: "Retail",
      SectorTaxonomy: "finnhub_industry", PERatio: "35",
    }, false);
    expect(result.score).toBe(50);
    expect(result.evidence).toMatchObject({
      pe_scoring_status: "omitted_unmapped_sector",
      pe_sector_mapping_status: "unmapped",
    });
    expect(result.evidence).not.toHaveProperty("pe_sector_norm");
  });

  it("keeps a provider sector that directly matches the supported taxonomy", () => {
    const result = scoreFundamentals({
      Symbol: "INFY.NS", Sector: "Technology",
      SectorTaxonomy: "yahoo_sector", PERatio: "20",
    }, false);
    expect(result.score).toBe(68);
    expect(result.evidence).toMatchObject({
      pe_scoring_status: "applied", pe_sector_mapping_status: "direct",
      pe_sector_norm: 30,
    });
  });
});

describe("fundamental outlier contract", () => {
  it("omits near-zero-earnings P/E outliers instead of max-penalizing them", () => {
    const result = scoreFundamentals({
      Symbol: "NOISE", Sector: "Technology", PERatio: "8827.05",
    }, false);
    expect(MAX_SCORABLE_PE).toBe(200);
    expect(result.score).toBe(50);
    expect(result.evidence).toMatchObject({
      pe_ratio: 8827.05, pe_scoring_status: "omitted_outlier",
    });
  });

  it("does not count an outlier P/E toward the minimum real-field floor", () => {
    expect(hasMinFundamentalFields({ Symbol: "NOISE", PERatio: "8827", EPS: "1" })).toBe(false);
    expect(hasMinFundamentalFields({ Symbol: "VALID", PERatio: "25", EPS: "1" })).toBe(true);
  });
});

describe("insider availability contract", () => {
  it("rejects available=true when no valid score exists", () => {
    const missing = normalizeInsiderScore({ available: true, summary: "provider bug" });
    expect(missing).toMatchObject({ score: 50, available: false });
    expect(missing.evidence).toMatchObject({ data_contract_error: expect.any(String) });
    expect(normalizeInsiderScore({ available: true, score: Number.NaN }).available).toBe(false);
    expect(normalizeInsiderScore({ available: true, score: 101 }).available).toBe(false);
  });
});
