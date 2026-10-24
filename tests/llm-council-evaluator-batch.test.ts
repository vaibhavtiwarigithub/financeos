import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ calls: [] as any[], writes: [] as any[], fail: "", delayed: false }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => true }));
vi.mock("@/lib/analytics/benchmark-history", () => ({
  loadStoredResearchBenchmark: vi.fn(async () => {
    if (state.fail === "benchmark") throw new Error("private database detail");
    return state.delayed ? marks.map((date) => ({ date, close: 100 })) : [];
  }),
}));

const runs = ["us", "india"].flatMap((market, m) => Array.from({ length: 5 }, (_, i) => ({
  id: `${market}-${i}`, observation_id: m * 10 + i + 1, market, status: "completed",
  consensus_score: 60 + i, config_snapshot: { cohort_key: "all_research_v1", near_threshold_entry_long: true },
})));
const forecasts = runs.map((run, i) => ({ id: i, run_id: run.id, model_requested: "test-model",
  model_used: "test-model", execution_source: "api", status: "completed", initial_score: 60 + i % 5, final_score: 60 + i % 5,
  llm_council_runs: run,
}));
const marks = Array.from({ length: 23 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`)
  .filter((date) => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()));

vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from(table: string) {
  const call: any = { table, filters: {}, orders: [] };
  state.calls.push(call);
  const query: any = {
    select(fields: string) { call.fields = fields; return query; },
    eq(key: string, value: unknown) { call.filters[key] = value; return query; },
    in(key: string, value: unknown) { call.filters[key] = value; return query; },
    gte() { return query; },
    order(key: string) { call.orders.push(key); return query; },
    range(from: number, to: number) { call.range = [from, to]; return query; },
    insert(value: any) { call.insert = value; if (table === "llm_council_ic_runs") state.writes.push(value); return query; },
    update(value: any) { call.update = value; return query; },
    single() { return Promise.resolve({ data: { id: "receipt" }, error: null }); },
    then(resolve: any, reject: any) {
      let data: any[] = [];
      if (table === "llm_council_runs") data = runs;
      if (table === "llm_council_model_forecasts") data = call.filters.execution_source
        ? state.delayed ? forecasts.map((forecast, i) => ({ ...forecast, execution_source: "subscription", available_at: "2026-10-01T14:00:00Z",
            llm_council_runs: { ...runs[i], symbol: `${runs[i].market}${i % 5}`, completed_at: "2026-10-01T14:00:00Z",
              config_snapshot: { execution_mode: "hybrid" }, deterministic_score: { composite: 60 + i % 5 },
              prediction_contract: { version: "council_prediction_only_h10_v2" } },
          })) : [] : forecasts;
      if (table === "price_cache") data = call.filters.symbol.flatMap((symbol: string, i: number) => marks.map((date, day) => ({ symbol, date, close: 100 + day * (i + 1) })));
      if (table === "observation_labels") {
        const ids: number[] = call.filters.observation_id;
        data = runs.filter((run) => ids.includes(run.observation_id)).flatMap((run, i) => [2, 5, 10, 20].map((horizon) => ({
          observation_id: run.observation_id, horizon_days: horizon, benchmark_neutral_return: i / 100,
          decision_observations: { id: run.observation_id, market: run.market, symbol: `${run.market}${i}`,
            ts: "2026-10-01T14:00:00Z", analyst_score: 60 + i, score_threshold: 60,
            direction: "long", decision_context: "entry_candidate" },
        })));
      }
      const error = state.fail === table ? { message: "private database detail" } : null;
      return Promise.resolve({ data, error }).then(resolve, reject);
    },
  };
  return query;
} }) }));

import { POST } from "@/app/api/agents/llm-council/evaluate/route";

describe("council evaluator shared reads and atomic publication", () => {
  beforeEach(() => { state.calls = []; state.writes = []; state.fail = ""; state.delayed = false; });
  const request = () => new NextRequest("https://example.test/api/agents/llm-council/evaluate", { method: "POST" });

  it("loads only linked labels once per market, preserving every horizon/cohort and paired sample", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(state.writes).toHaveLength(1);
    const reads = state.calls.filter((c) => c.table === "observation_labels");
    expect(reads).toHaveLength(2);
    expect(reads.every((c) => c.filters.observation_id.length === 5 && c.filters.horizon_days.length === 4)).toBe(true);
    expect(state.calls.filter((c) => c.table === "llm_council_runs")).toHaveLength(1);
    for (const market of ["us", "india"]) for (const horizon of [2, 5, 10, 20]) for (const cohort of ["all_research_v1", "near_threshold_entry_long_v1"]) {
      const cells = state.writes[0].filter((c: any) => c.market === market && c.horizon_days === horizon && c.cohort_key === cohort);
      for (const series of ["composite:median", "deterministic:analyst_score_paired", "blend:equal_weight_50_50_paired", "model:test-model:independent", "model:test-model:debated"]) {
        expect(cells.find((c: any) => c.series_key === series)).toMatchObject({ observation_count: 5, qualifying_sessions: 1, mean_session_rank_ic: 1, t_stat: null, classification: "insufficient_evidence" });
      }
    }
    expect(state.calls.some((c) => c.update?.status === "done")).toBe(true);
    const history = state.calls.find((c) => c.fields?.startsWith("model_requested"));
    expect(history.orders).toEqual(["created_at", "id"]);
  });

  it.each(["benchmark", "observation_labels", "llm_council_model_forecasts"])("publishes nothing if %s fails", async (failure) => {
    state.fail = failure;
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(state.writes).toHaveLength(0);
    expect(await response.text()).not.toContain("private database detail");
    expect(state.calls.some((c) => c.update?.status === "error")).toBe(true);
  });

  it("does not record a successful receipt when the atomic insert fails", async () => {
    state.fail = "llm_council_ic_runs";
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(state.writes).toHaveLength(1);
    expect(state.calls.some((c) => c.update?.status === "done")).toBe(false);
    expect(await response.text()).toContain("publication unconfirmed; verify ledger before retry");
  });

  it("retains availability-aligned subscription scores, version identity and paired baselines without loading full packets", async () => {
    state.delayed = true;
    const response = await POST(request());
    expect(response.status).toBe(200);
    for (const market of ["us", "india"]) {
      const cells = state.writes[0].filter((cell: any) => cell.market === market && cell.cohort_key === "forecast_available_close_v2" && cell.horizon_days === 2);
      expect(cells).toHaveLength(5);
      expect(cells.every((cell: any) => cell.observation_count === 5 && cell.series_key.includes("|method=council_prediction_only_h10_v2") && cell.t_stat === null)).toBe(true);
    }
    const read = state.calls.find((call) => call.filters.execution_source === "subscription");
    expect(read.fields).not.toContain(",input_snapshot,");
    expect(read.fields).toContain("deterministic_score:input_snapshot->deterministic_score");
    expect(read.orders).toEqual(["available_at", "id"]);
    expect(state.writes).toHaveLength(1);
  });
});
