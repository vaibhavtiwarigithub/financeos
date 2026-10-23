import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261023184400_disk_io_hot_read_indexes.sql", "utf8")
  .replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

describe("measured Disk I/O access paths", () => {
  it.each([
    ["signal_score_history_created_desc_idx", "signal_score_history", "created_at DESC"],
    ["symbol_daily_returns_market_available_idx", "symbol_daily_returns", "market, available_at DESC"],
    ["provider_call_ledger_run_id_idx", "provider_call_ledger", "run_id"],
  ])("retains %s for its production read shape", (name, table, keys) => {
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${name} ON public.${table} (${keys});`);
  });

  it("bounds production lock waits and contains only three narrow additive indexes", () => {
    expect(sql).toContain("SET LOCAL lock_timeout = '2s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '45s';");
    expect(sql.match(/CREATE INDEX/g)).toHaveLength(3);
    expect(sql).not.toMatch(/\b(INCLUDE|UNIQUE|DROP|TRUNCATE|DELETE|UPDATE|INSERT|GRANT|REVOKE|POLICY|DISABLE|REINDEX|VACUUM)\b/i);
  });
});
