import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const route = readFileSync(`${root}/app/api/agents/downside-hedge/route.ts`, "utf8");
const migration = readFileSync(`${root}/supabase/migrations/20260715160000_downside_hedge.sql`, "utf8");
const monitor = readFileSync(`${root}/app/api/agents/position-monitor/route.ts`, "utf8");

describe("downside hedge safety contract", () => {
  it("has no live or broker execution dependency", () => {
    expect(route).not.toMatch(/executeApprovedOrder|execute-order|broker_order|trade_proposals/);
    expect(migration).not.toMatch(/live_|broker_order|trade_proposals/);
  });

  it("ships evaluation and paper execution off", () => {
    expect(migration).toContain("enabled boolean not null default false");
    expect(migration).toContain("paper_execute_enabled boolean not null default false");
  });

  it("hard-limits execution to unleveraged SH and PSQ", () => {
    expect(migration).toContain("p_symbol not in ('SH','PSQ')");
    expect(migration).toContain("symbol_not_hard_allowlisted");
  });

  it("records evaluation state and event in one transaction", () => {
    expect(migration).toContain("record_downside_hedge_evaluation");
    expect(migration).toContain("concurrent_or_duplicate_evaluation");
    expect(route).toContain('svc.rpc("record_downside_hedge_evaluation"');
  });

  it("keeps hedge positions outside conviction and target exits", () => {
    expect(monitor).toContain('pos.position_role !== "hedge" && sc?.score != null');
    expect(monitor).toContain('pos.position_role !== "hedge" && priceTarget');
    expect(monitor).toContain('pos.position_role === "hedge" && pos.exit_reason === "hedge_exit"');
  });
});
