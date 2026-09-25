import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const paperTrade = readFileSync("app/api/agents/paper-trade/route.ts", "utf8").replace(/\r\n/g, "\n");
const reportRoute = readFileSync("app/api/agents/missed-paper-opportunities/route.ts", "utf8").replace(/\r\n/g, "\n");
const migration = readFileSync("supabase/migrations/20260925220447_paper_missed_entry_counterfactual_ledger.sql", "utf8").replace(/\r\n/g, "\n");

describe("missed paper-entry evidence contract", () => {
  it("freezes only validated deterministic long signals after a dynamic risk plan", () => {
    expect(paperTrade).toContain('args.signal.direction !== "long"');
    expect(paperTrade).toContain("args.signal.session_validated !== true");
    expect(paperTrade).toContain('args.signal.score_source !== "deterministic_v1"');
    expect(paperTrade).toContain("riskPlan: riskPlanProvenance");
    expect(paperTrade).toContain("ignoreDuplicates: true");
    expect(paperTrade).toContain("diagnostic write failures must never block");
  });

  it("owner-gates reads and paginates every price/fill evidence source", () => {
    expect(reportRoute).toContain("requireOwner()");
    expect(reportRoute.match(/fetchAllRows\(/g)?.length).toBe(3);
    expect(reportRoute).toContain("benchmarkSymbolFor(market, \"portfolio\")");
    expect(reportRoute).toContain("fetchAllRows((from, to) => svc.from(\"symbol_daily_returns\")");
    expect(reportRoute).toContain("paper-buy reconciliation");
    expect(reportRoute).toContain('fill.symbol).toUpperCase() === String(event.symbol).toUpperCase()');
  });

  it("uses owner-read/service-write RLS and cannot be publicly read or written", () => {
    expect(migration).toContain("alter table public.paper_missed_opportunities enable row level security");
    expect(migration).toContain("'vterminater@gmail.com'");
    expect(migration).toContain("revoke all on public.paper_missed_opportunities from anon, authenticated");
    expect(migration).toContain("grant select on public.paper_missed_opportunities to authenticated");
    expect(migration).toContain("grant select, insert on public.paper_missed_opportunities to service_role");
  });
});
