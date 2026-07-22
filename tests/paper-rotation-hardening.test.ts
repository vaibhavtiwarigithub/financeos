import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  countDistinctPriorRotationRuns,
  executeCapitalRotationPaper,
} from "@/lib/trading/capital-rotation";

describe("paper capital-rotation hardening", () => {
  it("does not count the current shadow row or duplicate rows from one prior run as persistence", () => {
    const rows = [
      { audit_json: { run_id: "current" } },
      { audit_json: { run_id: "prior-a" } },
      { audit_json: { run_id: "prior-a" } },
      { audit_json: {} },
    ];
    expect(countDistinctPriorRotationRuns(rows, "current")).toBe(1);
  });

  it("is unreachable without the independent deployment gate", async () => {
    const previous = process.env.CAPITAL_ROTATION_PAPER_ENABLED;
    delete process.env.CAPITAL_ROTATION_PAPER_ENABLED;
    try {
      const result = await executeCapitalRotationPaper({}, {
        runId: "00000000-0000-0000-0000-000000000001",
        rotationsThisRun: 0,
        candidate: {
          signalId: "00000000-0000-0000-0000-000000000002",
          symbol: "TEST", market: "us", currency: "USD", score: 90,
          targetNotional: 1000, cash: 0, qty: 10, fillPrice: 100,
          priceTarget: 120, stopLoss: 90, sector: "Technology",
        },
        scoreThreshold: 60,
        minHoldingDays: 2,
      });
      expect(result).toEqual({ executed: false, reason: "deployment_disabled" });
    } finally {
      if (previous == null) delete process.env.CAPITAL_ROTATION_PAPER_ENABLED;
      else process.env.CAPITAL_ROTATION_PAPER_ENABLED = previous;
    }
  });

  it("keeps P1 database-disabled and refuses money movement after exact claim verification", () => {
    const sql = readFileSync("supabase/migrations/20260722185000_harden_paper_rotation_claim.sql", "utf8");
    expect(sql).toContain("rotation_paper_execution_p1_not_approved");
    expect(sql).toContain("and claim_run_id = p_claim_run_id");
    expect(sql).toContain("'signal_claim_not_owned'");
    expect(sql).toContain("'p1_guardrails_incomplete'");
    expect(sql).not.toContain("insert into public.paper_trades");
    expect(sql).not.toContain("delete from public.paper_positions");
    expect(sql).toContain("drop function if exists public.execute_paper_rotation");
  });
});
