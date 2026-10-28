import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  reads: [] as string[],
  selectByTable: {} as Record<string, string>,
  runs: [] as any[],
  forecasts: [] as any[],
  batches: [] as any[],
  workers: [] as any[],
}));

vi.mock("@/lib/auth/session-role", () => ({ requireViewerOrOwner: async () => ({ gate: null }) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({
  from(table: string) {
    h.reads.push(table);
    const chain: any = {
      select: (columns: string) => { h.selectByTable[table] = columns; return chain; },
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown) => unknown) => {
        const data = table === "llm_council_runs" ? h.runs
          : table === "llm_council_model_forecasts" ? h.forecasts
          : table === "llm_council_workers" ? h.workers
          : table === "llm_council_batches" ? h.batches : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return chain;
  },
}) }));
vi.mock("@/lib/research/score-history", () => ({ councilMemberOf: () => "claude" }));
vi.mock("@/lib/research/council-member-state", () => ({ buildCouncilMemberState: () => [
  { model: "claude-sonnet-4-6", member: "claude", source: "subscription", score: 72, status: "completed", reason: null },
] }));

import { GET } from "@/app/api/research/council/route";

describe("symbol council evidence route", () => {
  beforeEach(() => {
    h.reads = [];
    h.selectByTable = {};
    h.runs = [{
      id: "run-1", decision_ts: "2026-10-28T13:00:00Z", status: "completed", consensus_score: 72,
      completed_at: "2026-10-28T13:01:00Z", failure_code: null,
      config_snapshot: { cohort_key: "all_research_v1" }, cohort: "all_research_v1", prompt_version: "council-prediction-v2",
      det: "68", threshold: "60", direction: "long",
    }];
    h.forecasts = [{
      run_id: "run-1", model_requested: "claude-sonnet-4-6", model_used: "claude-sonnet-4-6",
      initial_score: 70, final_score: 72, confidence: 0.61, final_rationale: "Cloud growth is strong.",
      bull_case: "Cloud accelerates.", bear_case: "Capex remains high.", execution_source: "subscription",
      available_at: "2026-10-28T13:00:50Z",
      evidence_citations: [
        { claim: "Cloud growth", source: "fundamental.cloud_growth", as_of: "2026-10-27" },
        { claim: "Stale citation", source: "price", as_of: "unknown" },
        { claim: "Fourth is clipped", source: "macro.regime", as_of: "2026-10-28" },
        { claim: "Should not reach the card", source: "hidden", as_of: "2026-10-28" },
      ],
    }];
    h.batches = [];
    h.workers = [];
  });

  it("returns prompt identity and a bounded set of source citations for the symbol explanation", async () => {
    const response = await GET(new NextRequest("https://test.invalid/api/research/council?symbol=GOOGL&market=us"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs[0]).toMatchObject({ promptVersion: "council-prediction-v2", cohort: "all_research_v1" });
    expect(body.runs[0].members[0]).toMatchObject({
      model: "claude-sonnet-4-6", source: "subscription", score: 72,
      citations: [
        { claim: "Cloud growth", source: "fundamental.cloud_growth", asOf: "2026-10-27" },
        { claim: "Stale citation", source: "price", asOf: "unknown" },
        { claim: "Fourth is clipped", source: "macro.regime", asOf: "2026-10-28" },
      ],
    });
    expect(body.runs[0].members[0].citations).toHaveLength(3);
    expect(h.selectByTable.llm_council_runs).toContain("prompt_version");
    expect(h.selectByTable.llm_council_model_forecasts).toContain("evidence_citations");
  });
});
