import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("readiness check scales with the observation ledger (it timed out daily from 2026-09-26)", () => {
  const src = readFileSync("app/api/admin/readiness/route.ts", "utf8");
  it("counts labels with one server-side join, never by paging every observation id into an .in() list", () => {
    expect(src).toContain('decision_observations!inner(market)');
    expect(src).toContain('.eq("decision_observations.market", market)');
    expect(src).not.toContain('.in("observation_id", ids)');
    expect(src).not.toContain("fetchAllRows");
  });
});
