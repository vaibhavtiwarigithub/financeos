import { describe, expect, it } from "vitest";
import { isReitSector, scoreFundamentals } from "@/lib/data/scores";

// THE DEFECT THIS GUARDS. A REIT's net income is structurally suppressed by
// mandatory real-estate depreciation — P/E, profit margin, ROE, and EPS sign
// all mean something different for a REIT than for a normal company (the
// industry's own metric is FFO/AFFO, not net income). The scorer had no REIT
// awareness at all: verified in production 2026-09-09 that the one REIT ever
// scored (O) fell through FINNHUB_INDUSTRY_TO_SECTOR's exact-key crosswalk
// (Finnhub's raw industry string never matches the generic "real estate" key)
// and landed on mappingStatus "unmapped" — silently unscored by accident, not
// by design. Fixing the crosswalk ALONE would have been worse: it would then
// hit SECTOR_PE_NORM["real estate"] = 30, a tech-level norm that flags a
// perfectly normal ~45-50x REIT P/E as "rich" and penalizes it.
describe("isReitSector", () => {
  it("matches Finnhub's varied REIT sub-industry strings by substring, not an exact key", () => {
    expect(isReitSector("REIT - Retail")).toBe(true);
    expect(isReitSector("REIT - Diversified")).toBe(true);
    expect(isReitSector("Real Estate Services")).toBe(true);
    expect(isReitSector("real estate")).toBe(true); // case-insensitive
  });

  it("does not match an unrelated sector", () => {
    expect(isReitSector("Technology")).toBe(false);
    expect(isReitSector("Financial Services")).toBe(false);
    expect(isReitSector(undefined)).toBe(false);
    expect(isReitSector("")).toBe(false);
  });
});

describe("scoreFundamentals — REIT sector", () => {
  it("returns the honest neutral baseline instead of scoring on distorted net-income metrics", () => {
    // O's actual production overview shape: pe=47.15 (normal for a REIT,
    // would read as "rich" against the wrong tech-level norm), positive EPS.
    const overview = {
      Symbol: "O", Sector: "REIT - Retail", SectorTaxonomy: "finnhub_industry",
      PERatio: "47.1475", EPS: "1.3672", ProfitMargin: "0.28", ReturnOnEquityTTM: "0.03",
    };
    const result = scoreFundamentals(overview, false);
    expect(result.score).toBe(55);
    expect(result.evidence.note).toContain("REIT");
    // Must not have gone anywhere near the PE-vs-sector-norm branch — no
    // pe_scoring_status, no pe_vs_sector_ratio, nothing that implies a real
    // company's fundamentals were scored.
    expect(result.evidence.pe_scoring_status).toBeUndefined();
    expect(result.evidence.pe_vs_sector_ratio).toBeUndefined();
  });

  it("a non-REIT company with the same numeric inputs is scored normally, unaffected", () => {
    const overview = {
      Symbol: "AAPL", Sector: "Technology", SectorTaxonomy: "finnhub_industry",
      PERatio: "30", EPS: "6", ProfitMargin: "0.28", ReturnOnEquityTTM: "0.5",
    };
    const result = scoreFundamentals(overview, false);
    expect(result.score).not.toBe(55);
    expect(result.evidence.pe_scoring_status).toBeDefined();
  });

  it("an ETF still takes the ETF branch, not the REIT branch, even if it holds real estate", () => {
    // isEtf is checked first — a real-estate ETF symbol should never reach
    // the REIT branch's evidence shape.
    const overview = { Symbol: "VNQ", Sector: "Real Estate", SectorTaxonomy: "finnhub_industry" };
    const result = scoreFundamentals(overview, true);
    expect(result.evidence.note).toContain("ETF");
  });
});
