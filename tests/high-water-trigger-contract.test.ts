import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("closed-lot high-water table invariant", () => {
  const migration = readFileSync("supabase/migrations/20260911194022_enforce_closed_trade_high_water.sql", "utf8");
  const rollbackTest = readFileSync("scripts/sql/test-capture-closed-trade-high-water.sql", "utf8");

  it("captures at the table boundary before an open lot closes", () => {
    expect(migration).toContain("before update of closed_at");
    expect(migration).toContain("old.closed_at is null and new.closed_at is not null");
    expect(migration).toContain("v_position_high");
  });

  it("tests full, partial, and residual close paths under rollback", () => {
    expect(rollbackTest).toContain("test_high_water");
    expect(rollbackTest).toContain("test_partial_high_water");
    expect(rollbackTest).toContain("test_residual_high_water");
    expect(rollbackTest.trim().endsWith("rollback;")).toBe(true);
  });
});
