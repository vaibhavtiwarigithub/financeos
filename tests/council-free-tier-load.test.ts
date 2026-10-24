import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mock = vi.hoisted(() => ({ reads: [] as any[], allScored: false, missing: false, active: 0, peak: 0,
  service: vi.fn(), enqueue: vi.fn(), llm: vi.fn(), allowed: true }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => mock.allowed }));
vi.mock("@/lib/llm-router", () => ({ callLLM: mock.llm, isReasoningModel: () => false, priceFor: () => [0, 0] }));
vi.mock("@/lib/llm-council/subscription", () => ({ sweepSubscriptionBatches: vi.fn(), enqueueSubscription: mock.enqueue }));
const rows = (market: string) => Array.from({ length: 6 }, (_, i) => ({
  id: i + 1, ts: "2026-10-23T12:00:00.000Z", market, symbol: `TEST${i}`, analyst_score: 60 + i,
  score_threshold: 60, direction: "long", decision_context: "entry_candidate", features: { source: "frozen" },
  availability_mask: {}, technical_score: 65, currency: market === "us" ? "USD" : "INR",
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => {
  mock.service();
  return { from(table: string) {
    const read: any = { table, eq: {} }; mock.reads.push(read);
    const builder: any = {
      select(fields: string) { read.fields = fields; return builder; },
      eq(key: string, value: any) { read.eq[key] = value; return builder; },
      gte() { return builder; }, lt() { return builder; }, lte() { return builder; },
      in() { return builder; }, order() { return builder; }, limit() { return builder; },
      range() { return builder; }, single() { return builder; }, maybeSingle() { return builder; },
      then(resolve: any, reject: any) {
        let data: any = [];
        if (table === "llm_council_config") data = { enabled: true, execution_mode: "subscription", subscription_worker_ids: ["test-worker"],
          max_symbols_per_market_day: 400, daily_budget_usd: 1, debate_rounds: 0 };
        if (table === "decision_observations") {
          const source = rows(read.eq.market);
          data = read.eq.id ? (mock.missing ? null : source.find((r) => r.id === read.eq.id))
            : source.map(({ features: _features, ...row }) => row);
        }
        if (table === "llm_council_runs" && read.fields === "observation_id,symbol,decision_ts" && mock.allScored) {
          data = rows(read.eq.market).map((r) => ({ observation_id: r.id, symbol: r.symbol, decision_ts: r.ts }));
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  } };
} }));
import { POST } from "@/app/api/agents/llm-council/cron/route";
import { councilSweepDelaySeconds } from "@/lib/llm-council/limits";

describe("owner-selected Free tier council workload", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T13:15:00Z")); vi.clearAllMocks();
    mock.reads = []; mock.allScored = false; mock.missing = false; mock.active = 0; mock.peak = 0; mock.allowed = true;
    mock.enqueue.mockImplementation(async () => {
      mock.active++; mock.peak = Math.max(mock.peak, mock.active);
      await new Promise((resolve) => setTimeout(resolve, 1)); mock.active--;
      return "synthetic-test-batch";
    });
  });
  afterEach(() => vi.useRealTimers());
  const req = (market: string) => new NextRequest(`https://example.test/api/agents/llm-council/cron?market=${market}`, { method: "POST" });

  it.each(["us", "india"])("hydrates only admitted %s candidates and caps concurrency at two", async (market) => {
    const pending = POST(req(market)); await vi.runAllTimersAsync(); const response = await pending;
    expect(response.status).toBe(200);
    expect(mock.enqueue).toHaveBeenCalledTimes(6);
    expect(mock.peak).toBe(2);
    const reads = mock.reads.filter((r) => r.table === "decision_observations");
    expect(reads.find((r) => !r.eq.id).fields.split(",")).not.toContain("features");
    expect(reads.filter((r) => r.eq.id)).toHaveLength(6);
    for (const [, , packet, observationId] of mock.enqueue.mock.calls) {
      expect(packet.features).toEqual({ source: "frozen" });
      expect(observationId).toBeGreaterThan(0);
    }
    expect(mock.llm).not.toHaveBeenCalled();
  });

  it("reads no large feature packets when all observations were already scored", async () => {
    mock.allScored = true;
    const response = await POST(req("us"));
    expect(response.status).toBe(200);
    expect(mock.reads.filter((r) => r.table === "decision_observations").every((r) => !r.fields.split(",").includes("features"))).toBe(true);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });

  it("missing frozen data blocks without inference or consuming the observation", async () => {
    mock.missing = true;
    const response = await POST(req("us"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ blocked: true, remainingUnscored: 6 });
    expect(mock.enqueue).not.toHaveBeenCalled(); expect(mock.llm).not.toHaveBeenCalled();
  });

  it("defers intermediate sweeps before creating any database client", async () => {
    vi.setSystemTime(new Date("2026-10-23T13:05:00Z"));
    const response = await POST(req("india"));
    expect(await response.json()).toMatchObject({ deferred: "free_tier_quarter_hour_sweep", retryAfterSeconds: 600, shadowOnly: true });
    expect(mock.service).not.toHaveBeenCalled(); expect(mock.enqueue).not.toHaveBeenCalled();
  });

  it("still checks authorization before returning a deferral", async () => {
    mock.allowed = false;
    vi.setSystemTime(new Date("2026-10-23T13:05:00Z"));
    expect((await POST(req("us"))).status).toBe(401);
    expect(mock.service).not.toHaveBeenCalled();
  });

  it("quarter-hour timing is UTC and remains bounded at hour rollover", () => {
    expect(councilSweepDelaySeconds(new Date("2026-10-23T13:00:00Z"))).toBe(0);
    expect(councilSweepDelaySeconds(new Date("2026-10-23T13:15:30Z"))).toBe(0);
    expect(councilSweepDelaySeconds(new Date("2026-10-23T13:59:59Z"))).toBe(1);
  });
});
