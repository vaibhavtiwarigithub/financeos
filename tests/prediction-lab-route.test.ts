import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ gate: vi.fn(), service: vi.fn(), from: vi.fn(), tables: {} as Record<string, any[]>, fail: "" }));
vi.mock("@/lib/auth/session-role", () => ({ requireViewerOrOwner: mocks.gate }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.service }));
import { GET } from "@/app/api/learning/prediction-lab/route";

function request(query = "market=us&horizon=2") { return new NextRequest(`https://test/api/learning/prediction-lab?${query}`); }

describe("Prediction Lab read-only projection", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T16:00:00Z"));
    mocks.gate.mockResolvedValue({ gate: null }); mocks.service.mockReturnValue({ from: mocks.from });
    mocks.tables = {}; mocks.fail = ""; mocks.from.mockClear(); mocks.service.mockClear();
    mocks.from.mockImplementation((table: string) => {
      let rows = [...(mocks.tables[table] ?? [])];
      const q: any = {};
      q.select = q.order = () => q;
      q.eq = (key: string, value: unknown) => { rows = rows.filter((r) => r[key] === value); return q; };
      q.in = (key: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(r[key])); return q; };
      q.gte = (key: string, value: string) => { rows = rows.filter((r) => r[key] >= value); return q; };
      q.lte = (key: string, value: string) => { rows = rows.filter((r) => r[key] <= value); return q; };
      q.range = async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: mocks.fail === table ? { message: "internal read failure" } : null });
      // Intentionally no insert/update/delete/rpc: any write fails this test.
      return q;
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("authenticates before constructing a service-role client", async () => {
    mocks.gate.mockResolvedValue({ gate: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    expect((await GET(request())).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("rejects invalid market and horizon without reading private data", async () => {
    expect((await GET(request("market=crypto&horizon=2"))).status).toBe(400);
    expect((await GET(request("market=us&horizon=3"))).status).toBe(400);
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it.each(["us", "india"] as const)("returns paired raw-point IC and frozen baseline for %s without writes or providers", async (market) => {
    const dates = ["2026-09-28", "2026-09-29", "2026-09-30"];
    mocks.tables.llm_council_runs = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, observation_id: `o${i}`, symbol: `S${i}`, market, status: "completed",
      created_at: "2026-09-28T07:00:00Z", decision_ts: "2026-09-28T07:00:00Z",
      config_snapshot: { cohort_key: "all_research_v1" }, prompt_version: "test-v1", deterministic: { composite: 100 - i * 20 },
    }));
    mocks.tables.llm_council_model_forecasts = Array.from({ length: 5 }, (_, i) => ({
      id: `f${i}`, run_id: `r${i}`, status: "completed", created_at: "2026-09-28T08:00:00Z",
      available_at: "2026-09-28T08:00:00Z", model_requested: "requested", model_used: "actual", execution_source: "subscription", initial_score: i * 20,
    }));
    mocks.tables.price_cache = ["SPY", ...Array.from({ length: 5 }, (_, i) => `S${i}`)].flatMap((symbol) =>
      dates.map((date, i) => ({ symbol, date, close: 100 + (symbol === "SPY" ? 0 : Number(symbol.slice(1)) * i) })));
    // Use the versioned registry benchmark rather than assuming SPY.
    const { benchmarkSymbolFor } = await import("@/lib/data/benchmark-registry");
    const benchmark = benchmarkSymbolFor(market, "research");
    for (const mark of mocks.tables.price_cache) if (mark.symbol === "SPY") mark.symbol = benchmark;
    if (market === "india") {
      mocks.tables.benchmarks = [{ id: "nifty", market, symbol: benchmark, provider_symbol: benchmark, enabled: true, currency: "INR" }];
      mocks.tables.benchmark_price_observations = dates.map((date) => ({ benchmark_id: "nifty", component_symbol: benchmark, date, close: 100, source_status: "ok" }));
      mocks.tables.price_cache = mocks.tables.price_cache.filter((mark) => mark.symbol !== benchmark);
    }
    const response = await GET(request(`market=${market}&horizon=2`)); const body = await response.json();
    expect(response.status).toBe(200); expect(body.coverage.labelledRuns).toBe(5);
    const cell = body.cells.find((c: any) => c.method.startsWith("requested → actual"));
    expect(cell.ic).toBeCloseTo(1); expect(cell.baselineIc).toBeCloseTo(-1); expect(cell.deltaIc).toBeCloseTo(2);
    expect(cell.descriptiveHacT).toBeNull(); expect(body.shadowOnly).toBe(true);
    expect(body.coverage.benchmarkMarks).toBe(3);
    expect(body.benchmarkSource).toBe(market === "india" ? "benchmark_price_observations" : "price_cache");
    expect(JSON.stringify(body)).not.toContain("input_snapshot");
  });
  it("never silently substitutes another India benchmark when exact identity is absent", async () => {
    mocks.tables.benchmarks = [{ id: "other", market: "india", symbol: "OTHER", provider_symbol: "OTHER", enabled: true, currency: "INR" }];
    expect((await GET(request("market=india&horizon=2"))).status).toBe(503);
  });
  it("fails closed on a source read failure, not an empty successful result", async () => {
    mocks.fail = "llm_council_runs";
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("internal read failure");
  });
});
