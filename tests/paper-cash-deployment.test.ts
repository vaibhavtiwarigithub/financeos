import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { constructPortfolio } from "@/lib/portfolio/constructor";
import { resolvePaperExposureLimits } from "@/lib/portfolio/paper-limits";

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("paper cash-deployment policy stays paper-only and bounded", () => {
  it("uses a dedicated paper ceiling while preserving the shared cap for live checks", () => {
    const paper = read("app/api/agents/paper-trade/route.ts");
    const live = read("lib/risk/live-portfolio-gate.ts");
    const migration = read("supabase/migrations/20261008150000_paper_concentration_ceilings.sql");
    const grossMigration = read("supabase/migrations/20260929215748_paper_only_gross_exposure_ceiling.sql");
    expect(paper).toContain("max_gross_exposure_pct_paper");
    expect(paper).toContain("max_sector_exposure_pct_paper");
    expect(paper).toContain("max_name_exposure_pct_paper");
    expect(paper).toContain("paperExposureError");
    expect(paper).toContain("(cfg as any)?.max_gross_exposure_pct ?? DEFAULT_LIMITS.maxGrossExposurePct");
    expect(live).not.toContain("max_gross_exposure_pct_paper");
    expect(live).not.toContain("max_sector_exposure_pct_paper");
    expect(live).not.toContain("max_name_exposure_pct_paper");
    expect(grossMigration).toContain("default 100");
    expect(grossMigration).toContain("max_gross_exposure_pct_paper <= 100");
    expect(migration).toContain("default 60");
    expect(migration).toContain("default 20");
  });

  it("uses approved paper limits and falls back to shared limits before migration", () => {
    expect(resolvePaperExposureLimits({
      shared: { max_sector_exposure_pct: 30, max_name_exposure_pct: 12 },
      paper: { max_sector_exposure_pct_paper: 60, max_name_exposure_pct_paper: 20 },
      paperConfigAvailable: true,
    })).toEqual({ maxSectorExposurePct: 60, maxNameExposurePct: 20 });
    expect(resolvePaperExposureLimits({
      shared: { max_sector_exposure_pct: 30, max_name_exposure_pct: 12 },
      paper: null,
      paperConfigAvailable: false,
    })).toEqual({ maxSectorExposurePct: 30, maxNameExposurePct: 12 });
  });

  it("can use the 100% paper gross ceiling under 60% sector and 20% name caps while retaining the vol cap", () => {
    const book: Array<{ symbol: string; sector: string; valuePct: number; beta: null; dailyVol: null }> = [];
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      symbol: `N${i}`, market: "us" as const, proposedSizePct: 20,
      sector: `Sector${i}`, beta: null, dailyVol: 0.005,
    }));
    const result = constructPortfolio(book, candidates, {
      maxGrossExposurePct: 100, maxSectorExposurePct: 60, maxNameExposurePct: 20,
      maxPortfolioVolPct: 2, maxAvgPairwiseCorr: 0.7,
    });
    expect(result.orders).toHaveLength(8);
    expect(result.orders.every((order) => order.finalSizePct <= 20)).toBe(true);
    expect(result.orders.reduce((sum, order) => sum + order.finalSizePct, 0)).toBe(100);
    expect(result.bookAfter.estDailyVolPct).toBeLessThanOrEqual(2);
  });

  it("allows a risk-checked same-name add only when the raised paper ceilings create room", () => {
    const book = [
      { symbol: "AAA", sector: "Technology", valuePct: 12, beta: null, dailyVol: 0.005 },
      { symbol: "BBB", sector: "Technology", valuePct: 9, beta: null, dailyVol: 0.005 },
      { symbol: "CCC", sector: "Technology", valuePct: 9, beta: null, dailyVol: 0.005 },
    ];
    const candidate = [{ symbol: "AAA", market: "us" as const, proposedSizePct: 20, sector: "Technology", beta: null, dailyVol: 0.005 }];
    const previous = constructPortfolio(book, candidate, {
      maxGrossExposurePct: 100, maxSectorExposurePct: 30, maxNameExposurePct: 12,
      maxPortfolioVolPct: 2, maxAvgPairwiseCorr: 0.7,
    });
    const raisedPaper = constructPortfolio(book, candidate, {
      maxGrossExposurePct: 100, maxSectorExposurePct: 60, maxNameExposurePct: 20,
      maxPortfolioVolPct: 2, maxAvgPairwiseCorr: 0.7,
    });
    expect(previous.orders[0].finalSizePct).toBe(0);
    expect(raisedPaper.orders[0].finalSizePct).toBeGreaterThan(0);
    expect(raisedPaper.orders[0].finalSizePct).toBeLessThanOrEqual(8);
    expect(raisedPaper.bookAfter.grossPct).toBeLessThanOrEqual(100);
    expect(raisedPaper.bookAfter.estDailyVolPct).toBeLessThanOrEqual(2);
  });
});
