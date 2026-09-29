import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { constructPortfolio } from "@/lib/portfolio/constructor";

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("paper cash-deployment policy stays paper-only and bounded", () => {
  it("uses a dedicated paper ceiling while preserving the shared cap for live checks", () => {
    const paper = read("app/api/agents/paper-trade/route.ts");
    const live = read("lib/risk/live-portfolio-gate.ts");
    const migration = read("supabase/migrations/20260929215748_paper_only_gross_exposure_ceiling.sql");
    expect(paper).toContain("max_gross_exposure_pct_paper");
    expect(paper).toContain('.select("max_gross_exposure_pct_paper")');
    expect(paper).toContain("paperExposureError");
    expect(paper).toContain("(cfg as any)?.max_gross_exposure_pct ?? DEFAULT_LIMITS.maxGrossExposurePct");
    expect(live).not.toContain("max_gross_exposure_pct_paper");
    expect(migration).toContain("default 100");
    expect(migration).toContain("max_gross_exposure_pct_paper <= 100");
  });

  it("allows a fully populated eight-name paper book without bypassing the 12% name cap", () => {
    const book: Array<{ symbol: string; sector: string; valuePct: number; beta: null; dailyVol: null }> = [];
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      symbol: `N${i}`, market: "us" as const, proposedSizePct: 20,
      sector: `Sector${i}`, beta: null, dailyVol: null,
    }));
    const result = constructPortfolio(book, candidates, {
      maxGrossExposurePct: 100, maxSectorExposurePct: 30, maxNameExposurePct: 12,
      maxPortfolioVolPct: 2, maxAvgPairwiseCorr: 0.7,
    });
    expect(result.orders).toHaveLength(8);
    expect(result.orders.every((order) => order.finalSizePct <= 12)).toBe(true);
    expect(result.orders.reduce((sum, order) => sum + order.finalSizePct, 0)).toBe(96);
  });
});
