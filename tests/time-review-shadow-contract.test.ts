import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { recordTimeReviewObservation } from "@/lib/trading/time-review-shadow";
import { defaultMandate } from "@/lib/trading-mandate";

describe("time-review shadow integration contract", () => {
  const migration = readFileSync("supabase/migrations/20260903203500_time_review_exit_shadow.sql", "utf8");
  const monitor = readFileSync("app/api/agents/position-monitor/route.ts", "utf8");
  const scheduledRoute = readFileSync("app/api/agents/horizon-extension-shadow/route.ts", "utf8");
  const status = readFileSync("lib/shadows/status.ts", "utf8");

  it("freezes observations/outcomes and gives clients read-only access", () => {
    expect(migration).toContain("time_review_exit_observations_no_mutate");
    expect(migration).toContain("time_review_exit_outcomes_no_mutate");
    expect(migration).toContain("before update or delete");
    expect(migration).toContain("grant select on public.time_review_exit_observations to authenticated");
    expect(migration).not.toContain("grant insert on public.time_review_exit_observations to authenticated");
  });

  it("records before the incumbent time-stop branch and matures from the existing daily job", () => {
    expect(monitor.indexOf("recordTimeReviewObservation(svc")).toBeGreaterThan(0);
    expect(monitor.indexOf("recordTimeReviewObservation(svc")).toBeLessThan(monitor.indexOf("if (ageDays > horizonDays)"));
    expect(scheduledRoute).toContain("matureTimeReviewOutcomes(svc");
  });

  it("Upgrade Path excludes the legacy daily ledger from readiness", () => {
    expect(status).toContain("timeReviewObservations");
    expect(status).toContain("market sessions with exact reviews and both matured outcomes");
    expect(status).toContain("legacy daily one-day-extension rows are retained as historical context but excluded from readiness");
  });

  it("the observer writes only the immutable evidence table", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
      expect(table).toBe("time_review_exit_observations");
      return { insert };
    });
    const result = await recordTimeReviewObservation({ from }, {
      runId: "test-run",
      now: new Date("2026-09-03T20:05:00Z"),
      reviewSession: "2026-09-03",
      market: "us",
      position: {
        id: "p1", symbol: "AAPL", market: "us", currency: "USD",
        opened_at: "2026-08-20T20:00:00Z", avg_cost: 100,
        current_price: 110, highest_price: 112, stop_loss: 103,
        initial_stop_loss: 93, position_role: "alpha",
      },
      ageDays: 10,
      horizonDays: 10,
      currentPrice: 110,
      score: { score: 72, direction: "long", createdAt: "2026-09-03T14:00:00Z" },
      scoreFresh: true,
      holdThreshold: 60,
      exitThreshold: 45,
      mandate: defaultMandate("us"),
      replacement: { symbol: "MSFT", score: 75 },
    });
    expect(result).toBe("inserted");
    expect(from).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      candidate_extension_days: [5, 10],
      candidate_eligible: true,
      replacement_symbol: "MSFT",
    }));
  });
});
