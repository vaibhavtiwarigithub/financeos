import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("home excludes research payloads but preserves market, threshold and window predicates", () => {
  const page = readFileSync("app/dashboard/page.tsx", "utf8");
  expect(page).not.toContain('from("agent_signals").select("*")');
  expect(page).not.toContain('from("agent_runs").select("*")');
  expect(page).toContain('eq("market", mkt).eq("status", "pending")');
  expect(page).toContain('or("market.eq.us,market.is.null")');
  expect(page).toContain('gte("completed_at", sevenDaysAgo)');
  expect(page).toContain('tradingMandate.score_threshold - 5');
  expect(page).toContain('id,symbol,direction,analyst_score,conviction,status,created_at');
});
