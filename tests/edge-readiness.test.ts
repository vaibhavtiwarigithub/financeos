import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  evaluateEdgeReadiness,
  selectIndependentWindows,
  type EdgeReadinessInput,
} from "@/lib/edges/readiness";

function row(overrides: Partial<EdgeReadinessInput> = {}): EdgeReadinessInput {
  return {
    edgeId: "macd_atr_12_26_9",
    market: "us",
    horizon: 10,
    windowEnd: "2026-07-20",
    createdAt: "2026-07-20T03:00:00Z",
    segmentType: "market",
    segmentValue: "all",
    ic: 0.04,
    tStat: 2.1,
    nObs: 96,
    evidenceQuality: "retrospective_current_universe",
    netOfFeeIc: null,
    turnover: null,
    ...overrides,
  };
}

function weeklyRows(count = 6): EdgeReadinessInput[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 5, 15 + index * 7)).toISOString().slice(0, 10);
    return row({ windowEnd: date, createdAt: `${date}T03:00:00Z` });
  });
}

describe("edge calibration readiness", () => {
  it("collapses provider revisions and refuses closely-spaced reruns as weekly progress", () => {
    const rows = [
      row({ windowEnd: "2026-07-20", createdAt: "2026-07-20T03:00:00Z", ic: 0.01 }),
      row({ windowEnd: "2026-07-20", createdAt: "2026-07-20T04:00:00Z", ic: 0.04 }),
      row({ windowEnd: "2026-07-18", createdAt: "2026-07-18T03:00:00Z" }),
      row({ windowEnd: "2026-07-13", createdAt: "2026-07-13T03:00:00Z" }),
    ];
    const selected = selectIndependentWindows(rows, 6);
    expect(selected.map(item => item.windowEnd)).toEqual(["2026-07-20", "2026-07-13"]);
    expect(selected[0].ic).toBe(0.04);
  });

  it("reports collecting before six independent windows", () => {
    const result = evaluateEdgeReadiness(weeklyRows(3));
    expect(result.stage).toBe("collecting");
    expect(result.windowsObserved).toBe(3);
    expect(result.nextAction).toContain("3 more");
  });

  it("requires stable sign, sample, IC, and t-stat after six windows", () => {
    const rows = weeklyRows().map((item, index) => index < 2 ? { ...item, ic: -0.03, tStat: -1.8 } : item);
    const result = evaluateEdgeReadiness(rows);
    expect(result.stage).toBe("needs_stability");
    expect(result.gates.stable_positive_sign).toBe(false);
  });

  it("requests the validation build when retrospective stability passes", () => {
    const result = evaluateEdgeReadiness(weeklyRows());
    expect(result.stage).toBe("ready_for_validation_build");
    expect(result.windowsObserved).toBe(6);
    expect(result.validationWindowsObserved).toBe(0);
    expect(result.nextAction).toContain("PIT walk-forward");
  });

  it("requires four cost/FDR windows before requesting shadow review", () => {
    const rows = weeklyRows().map((item, index) => index >= 2 ? {
      ...item,
      evidenceQuality: "pit_walk_forward_cost_adjusted_fdr",
      netOfFeeIc: index === 2 ? -0.002 : 0.025,
      turnover: 0.35,
    } : item);
    const result = evaluateEdgeReadiness(rows);
    expect(result.stage).toBe("ready_for_shadow_review");
    expect(result.validationWindowsObserved).toBe(4);
    expect(result.positiveValidationWindows).toBe(3);
  });

  it("fails closed on missing metrics and mixed identities", () => {
    const missing = weeklyRows();
    missing[0] = { ...missing[0], nObs: null };
    expect(evaluateEdgeReadiness(missing).stage).toBe("needs_stability");
    expect(() => evaluateEdgeReadiness([...weeklyRows(), row({ market: "india" })])).toThrow(/share edge, market, and horizon/);
  });

  it("keeps the route off scoring and trading tables and persists one-time milestones", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "app/api/agents/edge-readiness/route.ts"), "utf8");
    expect(route).toContain("validation_build_notified_at");
    expect(route).toContain("shadow_review_notified_at");
    expect(route).toContain("Measure-only");
    for (const forbidden of [
      "agent_signals", "strategy_config", "trading_mandates", "paper_positions",
      "paper_portfolio", "trade_proposals", "broker_orders",
    ]) {
      expect(route).not.toContain(`from(\"${forbidden}\")`);
    }
  });
});
