import { describe, expect, it } from "vitest";
import { buildEvolutionQueue } from "@/lib/agents/evolution-supervisor";

describe("governed evolution supervisor queue", () => {
  it("prioritizes safety and data integrity before producer failures and research work", () => {
    const queue = buildEvolutionQueue({
      alerts: [
        { issue_key: "broker-token:robinhood", severity: "critical", category: "broker", title: "Broker connection needs attention" },
        { issue_key: "research-budget:us", severity: "warn", category: "capacity", title: "Research budget deferred symbols" },
      ],
      runs: [{ agent_type: "price_refresh", market: "india", status: "error", started_at: "2026-10-28T10:00:00Z" }],
      strategies: [{ id: 4, market: "us", state: "challenger", validation_experiment_id: null }],
      automation: [{ market: "us", enabled: true, auto_shadow_enabled: true }],
      markets: ["us", "india"],
    });

    expect(queue.map((item) => item.priority)).toEqual(["P0", "P0", "P1", "P2"]);
    expect(queue.find((item) => item.key === "alert:broker-token:robinhood")?.priority).toBe("P0");
    expect(queue.find((item) => item.key === "alert:research-budget:us")?.status).toBe("waiting");
    expect(queue.find((item) => item.key === "validation:us")?.category).toBe("validation");
  });

  it("uses only the latest agent result so a successful run clears an old failure", () => {
    const queue = buildEvolutionQueue({
      alerts: [],
      runs: [
        { agent_type: "research", market: "us", status: "error", started_at: "2026-10-27T10:00:00Z" },
        { agent_type: "research", market: "us", status: "done", started_at: "2026-10-28T10:00:00Z" },
      ],
      strategies: [], automation: [], markets: ["us", "india"],
    });
    expect(queue.some((item) => item.key === "run:research:us")).toBe(false);
  });

  it("keeps paper-entry brakes separate from shadow validation progress", () => {
    const queue = buildEvolutionQueue({
      alerts: [], runs: [],
      strategies: [
        { id: 9, market: "us", state: "challenger", validation_experiment_id: null },
        { id: 10, market: "india", state: "shadow_paper", validation_experiment_id: 52 },
      ],
      automation: [
        { market: "us", enabled: true, auto_shadow_enabled: true },
        { market: "india", enabled: true, auto_shadow_enabled: true },
      ],
      markets: ["us", "india"],
    });

    const validation = queue.find((item) => item.key === "validation:us");
    expect(validation?.status).toBe("waiting");
    expect(validation?.nextAction).toContain("no paper-entry win-rate gate applies");
    expect(queue.find((item) => item.key === "shadow:india")?.status).toBe("collecting");
  });

  it("does not allow an off validation setting to appear as an automatic task", () => {
    const queue = buildEvolutionQueue({
      alerts: [], runs: [],
      strategies: [{ id: 11, market: "india", state: "challenger", validation_experiment_id: null }],
      automation: [{ market: "india", enabled: false, auto_shadow_enabled: false }],
      markets: ["us", "india"],
    });
    expect(queue.find((item) => item.key === "validation:india")?.status).toBe("blocked");
    expect(queue.find((item) => item.key === "validation:india")?.nextAction).toContain("will not enable it");
  });
});
