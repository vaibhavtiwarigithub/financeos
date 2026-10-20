import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("US and India Live Portfolio shared section layout", () => {
  const us = read("components/dashboard/LivePortfolioPage.tsx");
  const india = read("components/dashboard/IndiaLivePanel.tsx");
  const indiaPanels = read("components/dashboard/IndiaLiveGuardianPanels.tsx");

  it("keeps Guardian and Recommendations before broker connection, account summary and performance", () => {
    const usOrder = [
      us.indexOf("<GuardianProtectionPanel />"),
      us.indexOf("<RecommendationsPanel />"),
      us.indexOf("<RhReconnectBanner />"),
      us.indexOf("<LiveStatCards"),
      us.indexOf("<LivePerformanceChart"),
      us.indexOf("{/* Holdings table */}"),
    ];
    const indiaOrder = [
      india.indexOf("<IndiaManualTradeGuardianPanel />"),
      india.indexOf("<IndiaRecommendationsGuardianScorecard"),
      india.indexOf("{/* ── a) Connection status bar ── */}"),
      india.indexOf("<LiveStatCards"),
      india.indexOf("<LivePerformanceChart"),
      india.indexOf("NSE Holdings"),
    ];

    expect(usOrder.every((index) => index >= 0)).toBe(true);
    expect(indiaOrder.every((index) => index >= 0)).toBe(true);
    expect(usOrder).toEqual([...usOrder].sort((a, b) => a - b));
    expect(indiaOrder).toEqual([...indiaOrder].sort((a, b) => a - b));
  });

  it("gives the India scorecard the same responsive, collapsible dashboard treatment without mislabeling broker outcomes", () => {
    expect(indiaPanels).toContain("Recommendations & Guardian scorecard</div>");
    expect(indiaPanels).toContain('open ? "Collapse" : "Expand"');
    expect(indiaPanels).toContain("india-rec-table");
    expect(indiaPanels).toContain("india-rec-cards");
    expect(indiaPanels).toContain("All researched");
    expect(indiaPanels).toContain("Currently held");
    expect(indiaPanels).toContain("NIFTY 50");
    expect(indiaPanels).toContain("do not prove that you bought a recommendation");
    expect(indiaPanels).toContain("not inferential IC or t-stat evidence");
  });
});
