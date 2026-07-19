import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { estimatedClearDays, median } from "@/lib/agents/capacity";

describe("closed-day research catch-up safety contract", () => {
  const cron = readFileSync("app/api/agents/research/cron/route.ts", "utf8");
  const paper = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");
  const trader = readFileSync("app/api/agents/trader/route.ts", "utf8");
  const monitor = readFileSync("app/api/agents/position-monitor/route.ts", "utf8");
  const autonomousLive = readFileSync("lib/trading/autonomous-live.ts", "utf8");
  const autonomousShadow = readFileSync("lib/trading/autonomous-shadow.ts", "utf8");
  const rotation = readFileSync("lib/trading/capital-rotation.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20260719090000_weekend_research_catchup.sql", "utf8");
  const holidayMigration = readFileSync("supabase/migrations/20260719100000_market_holiday_research_catchup.sql", "utf8");

  it("writes weekend scores as unvalidated and does not chain PaperTrader", () => {
    expect(cron).toContain('status: "weekend_staged"');
    expect(cron).toContain("sessionValidated: false");
    expect(cron).toMatch(/if \(!closedDayCatchup\) \{[\s\S]*\/api\/agents\/paper-trade/);
  });

  it("requires positive session validation on both entry paths", () => {
    expect(paper).toContain('.eq("session_validated", true)');
    expect(trader).toContain('.eq("session_validated", true)');
    expect(autonomousLive).toContain('.eq("session_validated", true)');
    expect(autonomousShadow).toContain('.eq("session_validated", true)');
  });

  it("keeps staged scores out of conviction exits", () => {
    expect(monitor).toContain('.eq("session_validated", true)');
    expect(rotation).toContain('.eq("session_validated", true)');
  });

  it("enforces the staged invariant and unique active stage in Postgres", () => {
    expect(migration).toContain("status <> 'weekend_staged' or session_validated = false");
    expect(migration).toContain("where status = 'weekend_staged'");
  });

  it("runs closed-day triggers daily and delegates closure to the shared calendar", () => {
    expect(holidayMigration).toContain("'10 5 * * *'");
    expect(holidayMigration).toContain("'10 15 * * *'");
    expect(holidayMigration).toContain("mode=closed_day_catchup");
    expect(cron).toContain("getClosedDayCatchupEligibility");
    expect(cron).toContain("market-calendar-unsupported:");
    expect(cron).toContain('dayStatus.kind === "special_session"');
    expect(cron).toContain('mode: closedDayCatchup ? "closed_day_catchup" : "session"');
  });
});

describe("agent capacity estimates", () => {
  it("uses a median that is robust to one slow or bursty run", () => {
    expect(median([8, 9, 10, 40, 0])).toBe(9);
    expect(median([8, 10])).toBe(9);
    expect(median([])).toBeNull();
  });

  it("never fabricates clearing time without positive throughput", () => {
    expect(estimatedClearDays(26, 8)).toBe(4);
    expect(estimatedClearDays(0, 8)).toBe(0);
    expect(estimatedClearDays(10, 0)).toBeNull();
    expect(estimatedClearDays(null, 8)).toBeNull();
  });
});
