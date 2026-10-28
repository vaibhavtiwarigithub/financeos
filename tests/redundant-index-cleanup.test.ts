import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261028145623_remove_redundant_indexes.sql",
  "utf8",
);
const watchlistRoute = readFileSync("app/api/watchlist/route.ts", "utf8");

describe("redundant index cleanup", () => {
  it("drops only the duplicate experiment indexes and watchlist constraint", () => {
    expect(migration).toContain("DROP INDEX IF EXISTS public.er_gate_idx");
    expect(migration).toContain("DROP INDEX IF EXISTS public.er_strategy_idx");
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS watchlist_user_symbol_uniq",
    );
    expect(migration).not.toMatch(/DROP\s+(TABLE|SCHEMA)|TRUNCATE|DELETE\s+FROM/i);
  });

  it("retains the unique key required by app watchlist upserts", () => {
    expect(migration).toContain("watchlist_user_id_ticker_key");
    expect(watchlistRoute).toContain('onConflict: "user_id,symbol"');
  });
});
