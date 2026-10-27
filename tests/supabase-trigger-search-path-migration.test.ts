import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("pinned trigger-function search paths", () => {
  const migration = readFileSync(
    "supabase/migrations/20261027222643_pin_trigger_function_search_paths.sql",
    "utf8",
  );

  it("pins every reviewed production trigger function without changing grants", () => {
    for (const name of [
      "agentic_position_ledger_block_mutation",
      "india_news_snapshots_append_only",
      "live_exit_ladder_shadow_block_mutation",
      "prevent_profile_role_self_change",
      "price_cache_detect_restatement",
      "price_cache_restatements_append_only",
      "trial_family_ledger_append_only",
    ]) {
      expect(migration).toContain(`alter function public.${name}()`);
    }
    expect(migration.match(/set search_path = pg_catalog, public/g)).toHaveLength(7);
    const sql = migration.replace(/^\s*--.*$/gm, "");
    expect(sql).not.toMatch(/\bgrant\b|\brevoke\b|\bcreate\s+policy\b/i);
  });
});
