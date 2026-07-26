import { describe, expect, it } from "vitest";
import { formatLearnerRunSummary } from "@/lib/learning/run-summary";

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
});
