import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("earnings-risk P0 money-path wiring", () => {
  it("keeps paper annotations before both rotation and atomic fill paths", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/agents/paper-trade/route.ts"), "utf8");
    const annotation = source.indexOf("annotateEarningsRisk({");
    expect(annotation).toBeGreaterThan(-1);
    expect(source.indexOf("recordEarningsRiskObservation", annotation)).toBeGreaterThan(annotation);
    expect(source.indexOf("executeCapitalRotationPaper", annotation)).toBeGreaterThan(annotation);
    expect(source.indexOf('supabase.rpc("execute_paper_fill"', annotation)).toBeGreaterThan(annotation);
  });

  it("preserves the legacy live blackout and stores shadow context on proposals", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/agents/trader/route.ts"), "utf8");
    expect(source).toContain("diffDays >= -2 && diffDays <= 5");
    expect(source).toContain('reason: "earnings_blackout"');
    expect(source).toContain("riskReasons.earnings_risk = earningsRisk");
    expect(source).toContain("behaviorChanged: false");
  });

  it("does not wire earnings risk into PositionMonitor or live execution", () => {
    for (const file of [
      "app/api/agents/position-monitor/route.ts",
      "lib/trading/execute-order.ts",
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).not.toContain("earningsRiskVerdict");
      expect(source).not.toContain("annotateEarningsRisk");
    }
  });

  it("keeps raw provider payloads out of the owner-facing API", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/portfolio/earnings-risk/route.ts"), "utf8");
    expect(source).toContain("requireOwner()");
    expect(source).not.toContain("source_observations");
    expect(source).not.toContain("optionChain");
    expect(source).not.toContain("raw");
  });

  it("pins the persisted policy to behavior-inert shadow mode", () => {
    const migration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260729200000_earnings_risk_observations.sql"),
      "utf8",
    );
    expect(migration).toContain("check (policy_mode = 'shadow')");
    expect(migration).toContain("check (behavior_changed = false)");
  });
});
