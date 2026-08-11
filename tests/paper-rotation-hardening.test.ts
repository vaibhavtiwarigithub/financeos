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

  it("honors the database score-only gate before reading or moving the book", async () => {
    const previous = process.env.CAPITAL_ROTATION_PAPER_ENABLED;
    process.env.CAPITAL_ROTATION_PAPER_ENABLED = "true";
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data: {
          rotation_paper_execute_enabled: true,
          rotation_allow_score_only_paper: false,
        },
        error: null,
      }),
    };
    try {
      const result = await executeCapitalRotationPaper({ from: () => chain }, {
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
      expect(result).toEqual({ executed: false, reason: "score_only_execution_disabled" });
    } finally {
      if (previous == null) delete process.env.CAPITAL_ROTATION_PAPER_ENABLED;
      else process.env.CAPITAL_ROTATION_PAPER_ENABLED = previous;
    }
  });

  it("restores paper execution containment while keeping shadow measurement", () => {
    const sql = readFileSync("supabase/migrations/20260811033335_disable_unqualified_paper_rotation.sql", "utf8");
    expect(sql).toContain("rotation_paper_execute_enabled = false");
    expect(sql).toContain("where book_type = 'paper'");
    expect(sql).not.toContain("rotation_shadow_enabled = false");
  });

  it("loads a complete revision-collapsed return cohort without exposing the RPC", () => {
    const sql = readFileSync("supabase/migrations/20260722203000_rotation_shadow_readiness.sql", "utf8");
    expect(sql).toContain("distinct on (r.symbol, r.session_date)");
    expect(sql).toContain("cardinality(p_symbols) between 1 and 20");
    expect(sql).toContain("security invoker");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
