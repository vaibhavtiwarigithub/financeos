import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { groupCouncilUsageRows, type CouncilUsageRecord } from "@/lib/llm-council/usage-view";

const row = (overrides: Partial<CouncilUsageRecord> = {}): CouncilUsageRecord => ({
  usage_date: "2026-10-10",
  market: "us",
  execution_source: "api",
  model_requested: "gpt-5.6-luna",
  model_actual: "gpt-5.6-luna",
  role: "independent",
  record_count: 1,
  failure_count: 0,
  input_tokens: 120,
  output_tokens: 40,
  input_unknown_records: 0,
  output_unknown_records: 0,
  estimated_api_cost_usd: "0.0042",
  lease_attempts: 0,
  timestamp_basis: "turn recorded at",
  ...overrides,
});

describe("LLM council daily usage view", () => {
  it("groups only rows from the same market-local day, pipeline, and execution source", () => {
    const groups = groupCouncilUsageRows([
      row(),
      row({ role: "debate", record_count: 2, input_tokens: 200, output_tokens: 50, estimated_api_cost_usd: 0.01 }),
      row({ market: "india" }),
      row({ execution_source: "subscription", estimated_api_cost_usd: null, model_requested: "gpt-5.6-sol", model_actual: "gpt-5.6-sol" }),
      row({ usage_date: "2026-10-09" }),
    ]);
    expect(groups).toHaveLength(4);
    const usApi = groups.find((g) => g.market === "us" && g.executionSource === "api" && g.usageDate === "2026-10-10");
    expect(usApi?.records).toBe(3);
    expect(usApi?.inputTokens).toBe(320);
    expect(usApi?.outputTokens).toBe(90);
    expect(usApi?.estimatedApiCostUsd).toBeCloseTo(0.0142);
    expect(usApi?.details.map((d) => d.role).sort()).toEqual(["debate", "independent"]);
  });

  it("keeps missing token reports unknown and never turns subscription cost into zero dollars", () => {
    const [group] = groupCouncilUsageRows([row({
      execution_source: "subscription",
      model_requested: "claude-sonnet",
      model_actual: "claude-sonnet",
      input_tokens: 0,
      output_tokens: 0,
      input_unknown_records: 1,
      output_unknown_records: 1,
      estimated_api_cost_usd: null,
      lease_attempts: 2,
      timestamp_basis: "queued/lease day; result time unavailable",
    })]);
    expect(group.estimatedApiCostUsd).toBeNull();
    expect(group.inputUnknownRecords).toBe(1);
    expect(group.outputUnknownRecords).toBe(1);
    expect(group.leaseAttempts).toBe(2);
  });

  it("marks a grouped API cost unknown if any contained turn has unverified usage", () => {
    const [group] = groupCouncilUsageRows([
      row(),
      row({ role: "orchestrator", input_unknown_records: 1, output_unknown_records: 1, estimated_api_cost_usd: null }),
    ]);
    expect(group.records).toBe(2);
    expect(group.estimatedApiCostUsd).toBeNull();
    expect(group.inputUnknownRecords).toBe(1);
  });

  it("keeps the daily RPC bounded, market-local, synthetic-excluding, owner-route-only", () => {
    const sql = readFileSync("supabase/migrations/20261011061905_llm_council_daily_usage.sql", "utf8");
    const route = readFileSync("app/api/agents/llm-council/usage/route.ts", "utf8");
    expect(sql).toContain("p_days not in (7, 30, 90)");
    expect(sql).toContain("America/New_York");
    expect(sql).toContain("Asia/Kolkata");
    expect(sql).toContain("not b.synthetic");
    expect(sql).toContain("where coalesce(r.config_snapshot->>'execution_mode', 'api') = 'api'");
    expect(sql).toContain("revoke all on function public.llm_council_daily_usage(integer) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.llm_council_daily_usage(integer) to service_role");
    expect(route).toContain("await requireOwner()");
    expect(route).toContain("llm_council_daily_usage");
    expect(route).toContain("Cache-Control");
  });
});
