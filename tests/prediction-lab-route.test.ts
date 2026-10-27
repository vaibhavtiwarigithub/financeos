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
      const get = (row: any, key: string) => key.split(".").reduce((value, part) => value?.[part], row);
      q.select = q.order = () => q;
      q.eq = (key: string, value: unknown) => { rows = rows.filter((r) => get(r, key) === value); return q; };
      q.in = (key: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(r[key])); return q; };
      q.gte = (key: string, value: string) => { rows = rows.filter((r) => get(r, key) >= value); return q; };
      q.lte = (key: string, value: string) => { rows = rows.filter((r) => get(r, key) <= value); return q; };
      q.range = async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: mocks.fail === table ? { message: "internal read failure" } : null });
      q.then = (resolve: any, reject: any) => Promise.resolve({ data: rows, error: mocks.fail === table ? { message: "internal read failure" } : null }).then(resolve, reject);
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
  it("separates release periods in live matched comparisons without changing the baseline sample",async()=>{
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const dates=Array.from({length:16},(_,i)=>`2026-10-${String(i+12).padStart(2,"0")}`)
      .filter(d=>![0,6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
    mocks.tables.llm_council_runs=Array.from({length:10},(_,i)=>({id:`r${i}`,observation_id:`o${i}`,symbol:`S${i%5}`,market:"us",status:"completed",
      created_at:i<5?"2026-10-13T13:00:00Z":"2026-10-19T13:00:00Z",decision_ts:i<5?"2026-10-13T13:00:00Z":"2026-10-19T13:00:00Z",
      config_snapshot:{cohort_key:"all_research_v1",participant_models:["deepseek-flash"]},prompt_version:"test-v1",deterministic:{composite:50+i%5}}));
    mocks.tables.llm_council_model_forecasts=mocks.tables.llm_council_runs.map((r,i)=>({id:`f${i}`,run_id:r.id,status:"completed",created_at:r.created_at,
      available_at:r.created_at,model_requested:"deepseek-flash",model_used:"deepseek-flash",execution_source:"api",initial_score:60+i%5}));
    const {benchmarkSymbolFor}=await import("@/lib/data/benchmark-registry");const benchmark=benchmarkSymbolFor("us","research");
    mocks.tables.price_cache=[benchmark,...Array.from({length:5},(_,i)=>`S${i}`)].flatMap(symbol=>dates.map((date,i)=>({symbol,date,close:100+(symbol===benchmark?0:(Number(symbol.slice(1))+1)*i)})));
    const r=await GET(request());expect(r.status).toBe(200);const body=await r.json();
    expect(body.cells).toHaveLength(4);
    expect(body.cells.every((c:any)=>c.observations===5&&c.returnedPoints===5&&c.descriptiveHacT===null)).toBe(true);
    expect(body.cells.some((c:any)=>c.method.includes("Before Oct 17"))).toBe(true);
    expect(body.cells.some((c:any)=>c.method.includes("After Oct 17"))).toBe(true);
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
    // Three stock and two leveraged rows must not become one five-name IC.
    mocks.tables.llm_council_runs.forEach((run, i) => { run.instrument = { family: i < 3 ? "operating_company" : "leveraged_or_inverse_etf" }; });
    const separated = await (await GET(request(`market=${market}&horizon=2`))).json();
    expect(separated.cells).toHaveLength(4); // member and median per family
    expect(separated.cells.every((c: any) => c.ic == null && c.observations === 0)).toBe(true);
    expect(separated.cells.some((c: any) => c.method.includes("family leveraged_or_inverse_etf"))).toBe(true);
    mocks.tables.llm_council_runs[0].deterministic.composite = " ";
    const blank = await (await GET(request(`market=${market}&horizon=2`))).json();
    expect(blank.coverage.missingBaseline).toBe(1);
    mocks.tables.llm_council_runs[1].decision_ts = "invalid";
    const invalid = await (await GET(request(`market=${market}&horizon=2`))).json();
    expect(invalid.coverage.missingAvailability).toBe(1);
    mocks.tables.llm_council_runs[4].instrument = { family: "crypto" };
    const crypto = await (await GET(request(`market=${market}&horizon=2`))).json();
    expect(crypto.coverage.unsupportedFamilyRuns).toBe(1);
    expect(crypto.cells.every((c: any) => !c.method.includes("family crypto"))).toBe(true);
  });
  it("never silently substitutes another India benchmark when exact identity is absent", async () => {
    mocks.tables.benchmarks = [{ id: "other", market: "india", symbol: "OTHER", provider_symbol: "OTHER", enabled: true, currency: "INR" }];
    expect((await GET(request("market=india&horizon=2"))).status).toBe(503);
  });
  it("separates feature cohorts and rejects missing source-session proof", async () => {
    mocks.tables.observation_labels = Array.from({ length: 7 }, (_, i) => ({
      id: i, horizon_days: 2, matured_at: "2026-10-05T21:00:00Z", benchmark_neutral_return: i / 100,
      decision_observations: { id: i + 1, ts: "2026-10-01T13:00:00Z", symbol: `S${i}`, market: "us", signal_id: `signal${i}`, entry_eligible: true, direction: "long", decision_context: i === 5 ? "holding_review" : "entry_candidate", technical_score: 20 + i * 10, fundamental_score: 90 - i * 10, analyst_score: 50 + i, availability_mask: { technical: true, fundamental: true }, features: { instrument: { family: "operating_company" }, technical: { rsi14: 20 + i * 10, formula_version: "test-v2" }, formula_lineage: { versions: { technical: "test-v2", fundamental: "fund-test-v1", composite: "comp-test-v1" } } } },
    }));
    mocks.tables.agent_signals = Array.from({ length: 7 }, (_, i) => ({ id: `signal${i}`, market: "us", session_validated: i !== 6, as_of_session: "2026-10-01" }));
    const entry = await GET(request("view=features&market=us&horizon=2&cohort=entry"));
    expect(entry.status).toBe(200);
    const b = await entry.json();
    expect({ matched: b.matchedPoints, excluded: b.excludedRows }).toEqual({ matched: 5, excluded: 2 });
    expect(b.cells.find((c: any) => c.feature === "rsi14_level").rankIc).toBeCloseTo(1);
    expect(b.cells.every((c: any) => c.family === "operating_company")).toBe(true);
    expect(b.dimensionCells.find((c: any) => c.feature === "technical_score").rankIc).toBeCloseTo(1);
    expect(b.dimensionCells.find((c: any) => c.feature === "fundamental_score").rankIc).toBeCloseTo(-1);
    expect(b.dimensionCells.find((c: any) => c.feature === "fundamental_score").formula).toBe("fund-test-v1");
    expect(b.dimensionCells.find((c: any) => c.feature === "sentiment_score").availablePoints).toBe(0);
    const holding = await (await GET(request("view=features&market=us&horizon=2&cohort=holding"))).json();
    expect(holding.matchedPoints).toBe(1);
    expect(holding.cells.every((c: any) => c.rankIc == null)).toBe(true);
    expect((await GET(request("view=features&market=us&horizon=2&cohort=bad"))).status).toBe(400);
    // Frozen read cutoff excludes labels written later, even for old observations.
    mocks.tables.observation_labels[0].matured_at = "2026-10-22T00:00:00Z";
    const bounded = await (await GET(request("view=features&market=us&horizon=2&cohort=entry"))).json();
    expect(bounded.matchedPoints).toBe(4);
    // Missing/blank scores must not become zero or be classified as available.
    mocks.tables.observation_labels[1].decision_observations.fundamental_score = " ";
    mocks.tables.observation_labels[2].decision_observations.availability_mask.fundamental = false;
    const missing = await (await GET(request("view=features&market=us&horizon=2&cohort=entry"))).json();
    expect(missing.dimensionCells.find((c: any) => c.feature === "fundamental_score").availablePoints).toBe(2);
    expect(missing.dimensionCells.find((c: any) => c.feature === "fundamental_score").rankIc).toBeNull();
    // Real PostgREST projects narrow JSON paths; no full private features packet
    // is required by the reader. Keep the projected and legacy fixtures equal.
    for (const row of mocks.tables.observation_labels) {
      const o = row.decision_observations;
      o.technical = o.features.technical;
      o.formula_versions = o.features.formula_lineage.versions;
      o.instrument_family = o.features.instrument.family;
      delete o.features;
    }
    const projected = await (await GET(request("view=features&market=us&horizon=2&cohort=entry"))).json();
    expect(projected.dimensionCells).toEqual(missing.dimensionCells);
    expect(projected.cells).toEqual(missing.cells);
    mocks.tables.observation_labels[3].decision_observations.instrument_family = "crypto";
    const noCrypto = await (await GET(request("view=features&market=us&horizon=2&cohort=entry"))).json();
    expect(noCrypto.unsupportedFamilyRows).toBe(1);
    expect(noCrypto.matchedPoints).toBe(3);
    expect(noCrypto.cells.every((c: any) => c.family !== "crypto")).toBe(true);
    const longWindow = await (await GET(request("view=features&market=us&horizon=20&cohort=entry"))).json();
    expect(longWindow.lookbackDays).toBe(480);
  });
  it("fails closed on a source read failure, not an empty successful result", async () => {
    mocks.fail = "llm_council_runs";
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("internal read failure");
  });
  it("pairs recorded technical v2/v1 on identical rows with the stricter formula floor", async () => {
    mocks.tables.observation_labels = Array.from({ length: 15 }, (_, i) => {
      const legacy = 20 + Math.floor(i / 3) * 10, current = legacy + (i % 3 - 1) * 3;
      return { id: i, horizon_days: 2, matured_at: "2026-10-05T21:00:00Z", benchmark_neutral_return: i / 100,
        decision_observations: { id: i + 1, ts: "2026-10-01T13:00:00Z", symbol: `S${i}`, market: "us", signal_id: `signal${i}`, entry_eligible: true, direction: "long", decision_context: "entry_candidate", technical_score: current, availability_mask: { technical: true }, features: { instrument: { family: "operating_company" }, technical: { formula_version: "technical_dimension_v2_macd", score_trace: { formula_version: "technical_dimension_v2_macd", legacy_formula_version: "technical_dimension_v1", score: current, legacy_score: legacy } } } } };
    });
    mocks.tables.agent_signals = Array.from({ length: 15 }, (_, i) => ({ id: `signal${i}`, market: "us", session_validated: true, as_of_session: "2026-10-01" }));
    const b = await (await GET(request("view=features&market=us&horizon=2&cohort=entry"))).json();
    expect(b.pairedMacd).toHaveLength(1);
    expect(b.pairedMacd[0].minCrossSection).toBe(15);
    expect(b.pairedMacd[0].observations).toBe(15);
    expect(b.pairedMacd[0].ic).toBeCloseTo(1);
    expect(b.pairedMacd[0].deltaIc).toBeGreaterThan(0);
    expect(b.pairedMacd[0].descriptiveHacT).toBeNull();
    expect((await (await GET(request("view=features&market=us&horizon=2&cohort=entry&symbol=S0"))).json()).pairedMacd).toEqual([]);
    // A later observation with a missing trace removes its slot; it cannot
    // silently resurrect the older complete score and clear the 15-name floor.
    const first = mocks.tables.observation_labels[0];
    mocks.tables.observation_labels.push({ ...first, id: 100, decision_observations: { ...first.decision_observations, id: 101, ts: "2026-10-01T14:00:00Z", features: { instrument: { family: "operating_company" }, technical: { formula_version: "technical_dimension_v2_macd" } } } });
    const missing = await (await GET(request("view=features&market=us&horizon=2&cohort=entry"))).json();
    expect(missing.pairedMacd[0].returnedPoints).toBe(14);
    expect(missing.pairedMacd[0].sessions).toBe(0);
  });
});
