import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("app/api/paper-positions/close/route.ts", "utf8");
const migration = readFileSync(
  "supabase/migrations/20260928161500_atomic_manual_paper_exit_nav.sql",
  "utf8",
);

describe("paper position close contract", () => {
  it("fails closed on invalid market, missing/stale marks, and unapproved reasons", () => {
    expect(route).toContain('market !== "us" && market !== "india"');
    expect(route).toContain("unsupported paper exit reason");
    expect(route).toContain("!observedPrice || !Number.isFinite(observedPrice) || observedPrice <= 0 || stale");
  });

  it("uses the canonical atomic exit RPC; consolidation gets its atomic learning exclusion", () => {
    expect(route).toContain('svc.rpc("execute_paper_manual_exit"');
    expect(migration).toContain("public.execute_paper_exit(");
    expect(migration).toContain("SET excluded_from_learning = true");
    expect(migration).toContain("RAISE EXCEPTION 'owner consolidation attribution mismatch");
    expect(migration).toContain("SET nav = pool.cash_balance");
    expect(migration).toContain("TO service_role");
  });

  it("does not independently update/delete trades, positions, or portfolio cash", () => {
    expect(route).not.toMatch(/\.from\("paper_(trades|positions|portfolio)"\)\s*\.(update|delete)/);
    expect(route).toContain("computeExitFillPrice(observedPrice, bid)");
  });
});
