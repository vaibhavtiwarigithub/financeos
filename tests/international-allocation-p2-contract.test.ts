import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("international allocation P2A shadow contract", () => {
  const migration = read("supabase/migrations/20260727110000_international_allocation_p2_shadow.sql");
  const route = read("app/api/allocation/international/assess/route.ts");

  it("deduplicates weekly shadow evidence and schedules the protected observation endpoint", () => {
    expect(migration).toContain("international_allocation_weekly_shadow_once_idx");
    expect(migration).toContain("where observation_kind = 'p2_weekly'");
    expect(migration).toContain("kairos-international-allocation-shadow");
    expect(migration).toContain("/api/allocation/international/assess?mode=p2_weekly");
  });

  it("records a suppressed no-action and cannot expose scheduled mode to a browser owner", () => {
    expect(migration).toContain("'disabled_no_target'");
    expect(migration).toContain("'action', 'none'");
    expect(migration).toContain("'trading_cost_pct', null");
    expect(route).toContain("P2 weekly shadow is cron-only");
    expect(route).toContain("verifyCronSecret");
  });

  it("does not import a trading or provider path", () => {
    for (const forbidden of ["execute-order", "paper-trade", "getQuote", "fetch("]) {
      expect(route).not.toContain(forbidden);
    }
  });
});
