import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260927212341_capture_entry_risk_levels_for_attribution.sql",
  "utf8",
).replace(/\r\n/g, "\n");

describe("paper entry risk-level capture migration", () => {
  it("patches only the exact deployed execute_paper_fill signature and fails closed on drift", () => {
    expect(migration).toContain("public.execute_paper_fill(uuid,text,text,text,numeric,numeric,numeric,text,timestamptz");
    expect(migration).toContain("pg_get_functiondef(v_signature)");
    expect(migration).toContain("length(v_definition) - length(replace(v_definition, v_columns, '')) <> length(v_columns)");
    expect(migration).toContain("length(v_definition) - length(replace(v_definition, v_values, '')) <> length(v_values)");
  });

  it("persists the exact stop and target RPC arguments on the originating buy lot", () => {
    expect(migration).toContain("position_role, stop_loss, take_profit");
    expect(migration).toContain("'alpha'', p_stop_loss, p_price_target");
    expect(migration).toContain("Initial stop level supplied to execute_paper_fill at entry");
    expect(migration).toContain("Initial target level supplied to execute_paper_fill at entry");
  });

  it("does not backfill unrecoverable historical entry geometry or alter paper-position logic", () => {
    expect(migration).not.toMatch(/\bupdate\s+public\.paper_trades\b/i);
    expect(migration).not.toMatch(/\bupdate\s+public\.paper_positions\b/i);
    expect(migration).not.toMatch(/\bdelete\s+from\s+public\.(paper_trades|paper_positions)\b/i);
  });
});
