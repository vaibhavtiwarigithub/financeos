import { describe, expect, it } from "vitest";
import { formatLearnerFallbackMermaid, formatLearnerRunSummary } from "@/lib/learning/run-summary";

describe("formatLearnerRunSummary", () => {
  it("separates this-run orphan reconciliation from the closed learning corpus", () => {
    expect(formatLearnerRunSummary({
      reconciled: 0,
      reconciledWins: 0,
      reconciledLosses: 0,
      totalClosed: 17,
      totalWins: 9,
      totalLosses: 8,
    }, 3, 0)).toBe(
      "Reconciled 0 orphan trades (0W/0L) | Total closed: 17 (9W/8L). 3 hypotheses, 0 mutations.",
    );
  });

  it("does not label orphan reconciliation as newly closed trades", () => {
    const mermaid = formatLearnerFallbackMermaid({
      signals: 7675,
      totalClosed: 77,
      reconciledOrphans: 0,
      hypotheses: 0,
      macroChecked: true,
      priorsLoaded: true,
      steps: 17,
    });

    expect(mermaid).toContain("77 closed trades in learning corpus");
    expect(mermaid).toContain("0 orphan trades reconciled this run");
    expect(mermaid).toContain("macro: checked");
    expect(mermaid).toContain("priors: loaded");
    expect(mermaid).toContain("finish payload missing after 17 steps");
    expect(mermaid).not.toContain("trades closed this run");
    expect(mermaid).not.toContain("insufficient data");
  });
});
