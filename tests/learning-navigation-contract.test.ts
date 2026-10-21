import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const learning = readFileSync("components/dashboard/LearningPage.tsx", "utf8");
const prediction = readFileSync("components/dashboard/PredictionLabPanel.tsx", "utf8");
const features = readFileSync("components/dashboard/TechnicalFeatureDiagnosticsPanel.tsx", "utf8");

describe("Learning presentation contracts", () => {
  it("groups every existing evidence owner without duplicating it", () => {
    const ids = [...learning.matchAll(/<LearningSection id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["dimension-evidence", "council-evidence", "formula-evidence", "strategy-evidence", "market-evidence", "learning-history"]);
    for (const panel of ["PredictionLabPanel", "DimensionDiagnosticsSummary", "DimensionIcPanel", "IcRegressionPanel", "CouncilIcPanel", "ScoreFormulaMiningPanel", "StrategyGovernancePanel", "MacroContextPanel", "EventIcPanel", "IndexSleevePanel"]) {
      expect([...learning.matchAll(new RegExp(`<${panel}\\b`, "g"))]).toHaveLength(1);
    }
  });
  it("preserves keyboard-native disclosures and initial/hash/back navigation", () => {
    expect(learning).toContain("<details ref={ref}");
    expect(learning).toContain("<summary");
    expect(learning).toContain("ref.current?.contains(target)");
    expect(learning).toContain("ref.current.open = true");
    expect(learning).toContain('window.addEventListener("hashchange", reveal)');
    expect(learning).toContain('window.removeEventListener("hashchange", reveal)');
    expect(learning).toContain('document.addEventListener("click", followFragment)');
    expect(learning).toContain('document.removeEventListener("click", followFragment)');
    expect(learning).toContain("if (anchor?.hash) revealTarget(anchor.hash)");
    expect(learning).toContain("reveal();");
    expect(learning).toContain("{children}</div>");
  });
  it("does not assert obsolete schedules, fixed slots or automatic permission", () => {
    for (const obsolete of ["3 candidates / day", "Sunday 8 PM", "9 AM weekdays", "7-day horizon", "after 10+ closed trades", "60 – 69"]) expect(learning).not.toContain(obsolete);
    expect(learning).toContain("global, both markets");
    expect(learning).toContain('totalTrades > 0 ? winRate.toFixed(1) + "%"');
    expect(learning).toContain("not lifetime count");
  });
  it("bounds large tables without slicing or suppressing insufficient rows", () => {
    for (const source of [prediction, features]) {
      expect(source).toContain('overflow: "auto", maxHeight: 440');
      expect(source).toContain('position: "sticky"');
      expect(source).toContain("tabIndex={0}");
      expect(source).not.toContain(".slice(0,");
    }
  });
  it("handles non-JSON errors and does not install automatic retry storms", () => {
    for (const source of [prediction, features]) {
      expect(source).toContain("await r.json().catch(() => null)");
      expect(source).toContain("HTTP ${r.status}");
      expect(source).toContain("if (!controller.signal.aborted) setData(body)");
      expect(source).not.toContain("setInterval");
      expect(source).not.toContain("setTimeout");
    }
    expect(prediction).toContain("Retry comparison");
    expect(prediction).toContain("[market, horizon, request]");
    expect(features).toContain("Use Evaluate stored data to retry");
  });
});
