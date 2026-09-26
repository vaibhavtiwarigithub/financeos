import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("@/lib/system-health", () => ({ reconcileIssues: vi.fn() }));
import { reconcileIssues } from "@/lib/system-health";
import { reconcileRegressionAlerts } from "@/lib/learning/ic-regression-alert";
import type { CodeVersionCell } from "@/lib/learning/code-version-ic";

function cells(): CodeVersionCell[] {
  return [0.1, 0.12, 0.09, 0.11, 0.08, 0.1].map((ic, i) => ({
    market: "us", horizonDays: 10, dimension: "fundamental", codeVersion: `v${i}`,
    firstSeen: `2026-0${i + 1}-01`, lastSeen: `2026-0${i + 1}-28`, n: 100,
    qualifyingSessions: 30, meanIc: ic, sd: 0.1, tStat: 1, ci95: null, pValue: null,
    effectiveObservations: 30, classification: "measured_descriptive", reason: "fixture",
  }));
}
beforeEach(() => vi.clearAllMocks());
describe("IC alert reconciliation", () => {
  it("preserves existing alerts with missing or immature evidence", async () => {
    await reconcileRegressionAlerts("us", []);
    const rows = cells();
    rows[5].classification = "insufficient_evidence";
    await reconcileRegressionAlerts("us", rows);
    expect(reconcileIssues).not.toHaveBeenCalled();
  });
  it("resolves only the actually comparable series, not the whole market", async () => {
    await reconcileRegressionAlerts("us", cells());
    expect(reconcileIssues).toHaveBeenCalledWith("ic-regression:us:fundamental:h10:", [], undefined);
    expect(reconcileIssues).toHaveBeenCalledTimes(1);
  });
  it("does not treat nonfinite IC or another market as recovery", async () => {
    const rows = cells(); rows[5].meanIc = NaN;
    await reconcileRegressionAlerts("us", rows);
    await reconcileRegressionAlerts("india", cells());
    expect(reconcileIssues).not.toHaveBeenCalled();
  });
});
