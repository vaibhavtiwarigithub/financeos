import { describe, expect, it } from "vitest";
import { isReasoningModel } from "@/lib/llm-router";
import { isCouncilModel } from "@/lib/llm-model-catalog";
import { buildCouncilIcCell, equalWeightCouncilBlend, extractJson, medianScore, parseForecast, sha256, validateForecastCitations } from "@/lib/llm-council/core";

describe("LLM council score contract", () => {
  it("offers the requested GPT-5.6 Luna API model with explicit medium reasoning and nonzero pricing", () => {
    expect(isCouncilModel("gpt-5.6-luna")).toBe(true);
    expect(isReasoningModel("gpt-5.6-luna")).toBe(true);
  });

  it("accepts only bounded structured scores and dated evidence citations", () => {
    const parsed = parseForecast('```json\n{"score":72,"confidence":0.7,"rationale":"Evidence is mixed.","bull_case":"Growth","bear_case":"Valuation","evidence_citations":[{"claim":"RSI 54","source":"features.technical.rsi","as_of":"2026-09-29"},{"claim":"ignored","source":"x"}]}\n```');
    expect(parsed.score).toBe(72);
    expect(parsed.evidence_citations).toHaveLength(1);
    expect(() => parseForecast('{"score":101,"confidence":0.5}')).toThrow("model_score_out_of_range");
    expect(() => parseForecast('{"score":51,"confidence":2}')).toThrow("model_confidence_out_of_range");
    expect(() => extractJson("not json")).toThrow("model_output_not_json");
  });

  it("fails closed on routine-style smart quotes, prose-wrapped JSON, and string scores", () => {
    const routineStyle = '{“packet_id”:”synthetic-proof-001”,“score”:60,“confidence”:0.3}';
    expect(() => extractJson(routineStyle)).toThrow("model_output_invalid_json");
    expect(() => extractJson('Here is the forecast: {"score":60,"confidence":0.3}')).toThrow("model_output_not_json");
    expect(() => parseForecast(JSON.stringify({
      score: "60",
      confidence: 0.3,
      evidence_citations: [{ claim: "x", source: "price_at_decision", as_of: "unknown" }],
    }))).toThrow("model_score_not_numeric");
    expect(() => parseForecast(JSON.stringify({
      score: 60,
      confidence: "0.3",
      evidence_citations: [{ claim: "x", source: "price_at_decision", as_of: "unknown" }],
    }))).toThrow("model_confidence_not_numeric");
    expect(() => extractJson('[{"score":60}]')).toThrow("model_output_not_json");
  });

  it("uses the median to make composite aggregation reproducible", () => {
    expect(medianScore([90, 20, 60])).toBe(60);
    expect(medianScore([20, 80])).toBe(50);
    expect(medianScore([NaN, 120])).toBeNull();
  });

  it("computes only the fixed paired 50/50 blend and refuses missing or invalid inputs", () => {
    expect(equalWeightCouncilBlend(60, 80)).toBe(70);
    expect(equalWeightCouncilBlend("60", 80)).toBe(70);
    expect(equalWeightCouncilBlend(null, 80)).toBeNull();
    expect(equalWeightCouncilBlend(60, 101)).toBeNull();
  });

  it("computes date-clustered rank IC and withholds t-stat below the overlap floor", () => {
    const points = Array.from({ length: 24 }, (_, date) => Array.from({ length: 5 }, (_, symbol) => ({
      market: "us" as const,
      symbol: `S${symbol}`,
      ts: new Date(Date.UTC(2026, 0, date + 1, 21)).toISOString(),
      score: symbol * 10,
      benchmarkNeutralReturn: ((date % 4 === 0) ? 4 - symbol : symbol) * 0.01 + (date % 3) * (symbol % 2 ? 0.001 : -0.001),
    }))).flat();
    const h2 = buildCouncilIcCell("us", 2, "model:test:independent", "test", points);
    expect(h2.qualifyingSessions).toBe(24);
    expect(h2.independentWindows).toBe(12);
    expect(h2.classification).toBe("measured_descriptive");
    expect(h2.meanSessionRankIc).toBeGreaterThan(0);
    expect(h2.tStat).not.toBeNull();
    const h5 = buildCouncilIcCell("us", 5, "model:test:independent", "test", points);
    expect(h5.classification).toBe("insufficient_evidence");
    expect(h5.tStat).toBeNull();
    expect(h5.reason).toContain("need at least 20 sessions and 12 effective windows");
  });

  it("ignores sessions with fewer than five symbols and de-duplicates symbol/date rows", () => {
    const points = Array.from({ length: 8 }, (_, symbol) => ({ market: "india" as const, symbol: `A${symbol}`, ts: "2026-01-01T00:00:00Z", score: symbol, benchmarkNeutralReturn: symbol / 100 }));
    const cell = buildCouncilIcCell("india", 2, "composite:median", null, [...points, points[0]]);
    expect(cell.observationCount).toBe(8);
    expect(cell.qualifyingSessions).toBe(1);
    expect(cell.independentWindows).toBe(0.5);
    expect(cell.tStat).toBeNull();
  });

  it("hashes a frozen input deterministically", () => {
    expect(sha256("same")).toBe(sha256("same"));
    expect(sha256("same")).not.toBe(sha256("different"));
  });

  it("requires citations to resolve to frozen fields with their recorded as-of date", () => {
    const snapshot = { observed_at: "2026-09-30T15:00:00Z", price_at_decision: 100, features: { technical: { rsi: 52 } } };
    const priceForecast = parseForecast(JSON.stringify({ score: 60, confidence: 0.5, rationale: "Price evidence", bull_case: "Price holds", bear_case: "May fade", evidence_citations: [{ claim: "decision price", source: "price_at_decision", as_of: "2026-09-30" }] }));
    expect(validateForecastCitations(priceForecast, snapshot).evidence_citations).toHaveLength(1);
    const fabricated = parseForecast(JSON.stringify({ score: 60, confidence: 0.5, rationale: "Claims", bull_case: "Bull", bear_case: "Bear", evidence_citations: [{ claim: "future fact", source: "features.technical.rsi", as_of: "2026-09-30" }] }));
    expect(() => validateForecastCitations(fabricated, snapshot)).toThrow("model_citation_asof_unavailable");
    const missing = parseForecast(JSON.stringify({ score: 60, confidence: 0.5, rationale: "Claims", bull_case: "Bull", bear_case: "Bear", evidence_citations: [{ claim: "missing", source: "features.technical.macd", as_of: "unknown" }] }));
    expect(() => validateForecastCitations(missing, snapshot)).toThrow("model_citation_path_missing");
  });

  it("accepts array-element citations using bracket notation", () => {
    const snapshot = { point_in_time_relationships: { peer_prices: [{ symbol: "ABC", close: 12, latest_as_of_date: "2026-09-29" }] } };
    const forecast = parseForecast(JSON.stringify({
      score: 60, confidence: 0.5, rationale: "peer mark", bull_case: "up", bear_case: "down",
      evidence_citations: [{ claim: "peer close", source: "point_in_time_relationships.peer_prices[0].close", as_of: "2026-09-29" }],
    }));
    expect(validateForecastCitations(forecast, snapshot).evidence_citations).toHaveLength(1);
  });
  it("accepts the citation shapes DeepSeek Flash actually produced on 2026-10-12 (ITC.NS), still rejecting fabrication", () => {
    // Trimmed copy of the real frozen snapshot: only the fields the two failed replies cited.
    const snapshot = {
      observed_at: "2026-10-12T07:00:17.360903+00:00", price_at_decision: 266,
      deterministic_score: { composite: 65, availability_mask: { macro: false, technical: true } },
      features: {
        technical: { as_of: "2026-10-09", rsi14: 50.45 }, weighting: { renormalized: true },
        fundamental: { pe_ratio: 16.66 }, trade_plan: { reference_as_of: "2026-10-09", executable: false },
      },
    };
    const forecast = (...cites: Array<[string, string]>) => parseForecast(JSON.stringify({ score: 53, confidence: 0.6, rationale: "r", bull_case: "b", bear_case: "c",
      evidence_citations: cites.map(([source, as_of]) => ({ claim: "claim", source, as_of })) }));
    // Reply 1: root observed_at on deterministic_score.*, bare "fundamental"/"trade_plan", dated features.technical.
    const first = validateForecastCitations(forecast(
      ["deterministic_score.availability_mask", "2026-10-12T07:00:17.360903+00:00"], ["fundamental", "unknown"],
      ["features.technical", "2026-10-09"], ["trade_plan", "2026-10-09"]), snapshot);
    expect(first.evidence_citations.map((c) => c.source)).toEqual(["deterministic_score.availability_mask", "features.fundamental", "features.technical", "features.trade_plan"]);
    // Reply 2: "unknown" on a node that does carry a date is an honest under-claim.
    expect(validateForecastCitations(forecast(["features.weighting", "unknown"], ["features.technical", "unknown"], ["trade_plan", "2026-10-09"]), snapshot).evidence_citations).toHaveLength(3);
    // Comma-joined paths are split and each must resolve.
    expect(validateForecastCitations(forecast(["deterministic_score.composite, features.technical", "unknown"]), snapshot).evidence_citations.map((c) => c.source)).toEqual(["deterministic_score.composite", "features.technical"]);
    // Fabrication is still rejected: wrong date, date on an undated node, nonexistent path, one bad part in a list.
    expect(() => validateForecastCitations(forecast(["features.technical", "2026-10-01"]), snapshot)).toThrow("model_citation_asof_mismatch");
    expect(() => validateForecastCitations(forecast(["features.weighting", "2026-10-09"]), snapshot)).toThrow("model_citation_asof_unavailable");
    expect(() => validateForecastCitations(forecast(["risk_free_rate", "unknown"]), snapshot)).toThrow("model_citation_path_missing");
    expect(() => validateForecastCitations(forecast(["features.technical, made_up_field", "unknown"]), snapshot)).toThrow("model_citation_path_missing");
  });
  it("dates packet-level identity fields at the freeze timestamp (synthetic worker replies cite observed_at/symbol)", () => {
    const snapshot = { symbol: "TEST-NO-REAL-ASSET", market: "us", observed_at: "2026-10-12T16:00:00.000Z", synthetic: true, note: "n", facts: { as_of: "2026-10-10", trend_score: 55 } };
    const cite = (source: string, as_of: string) => parseForecast(JSON.stringify({ score: 50, confidence: 0.1, rationale: "r", bull_case: "b", bear_case: "c", evidence_citations: [{ claim: "c", source, as_of }] }));
    for (const source of ["observed_at", "symbol", "market", "synthetic", "note"]) expect(validateForecastCitations(cite(source, "2026-10-12T16:00:00.000Z"), snapshot).evidence_citations).toHaveLength(1);
    expect(validateForecastCitations(cite("facts.trend_score", "2026-10-10"), snapshot).evidence_citations).toHaveLength(1);
    expect(() => validateForecastCitations(cite("symbol", "2026-10-01"), snapshot)).toThrow("model_citation_asof_mismatch");
    expect(() => validateForecastCitations(cite("facts.trend_score", "2026-10-12"), snapshot)).toThrow("model_citation_asof_mismatch");
  });
  it("accepts common notations for real fields (pointer, brackets, wrapper prefix) but not for missing ones", () => {
    const snapshot = { symbol: "TEST-NO-REAL-ASSET", observed_at: "2026-10-12T16:00:00.000Z", facts: { as_of: "2026-10-10", trend_score: 55 } };
    const cite = (source: string) => parseForecast(JSON.stringify({ score: 50, confidence: 0.1, rationale: "r", bull_case: "b", bear_case: "c", evidence_citations: [{ claim: "c", source, as_of: "2026-10-10" }] }));
    for (const source of ["facts.trend_score", "/facts/trend_score", 'facts["trend_score"]', "snapshot.facts.trend_score", "FROZEN SNAPSHOT.facts.trend_score", "$.facts.trend_score"]) {
      expect(validateForecastCitations(cite(source), snapshot).evidence_citations[0].source).toBe("facts.trend_score");
    }
    expect(() => validateForecastCitations(cite("snapshot.facts.growth"), snapshot)).toThrow("model_citation_path_missing");
    expect(() => validateForecastCitations(cite("/facts/missing"), snapshot)).toThrow("model_citation_path_missing");
  });
  it("reads the real path out of the prose Claude Pro wrote in `source` (live synthetic reply, 2026-10-12)", () => {
    const snapshot = { symbol: "TEST-NO-REAL-ASSET", synthetic: true, observed_at: "2026-10-12T16:30:00.000Z", facts: { as_of: "2026-10-10", trend_score: 55, debt_to_equity: 0.3, revenue_growth_pct: 8 } };
    const forecast = parseForecast(JSON.stringify({ score: 50, confidence: 0.1, rationale: "r", bull_case: "b", bear_case: "c", evidence_citations: [
      { claim: "a", source: "facts.trend_score in frozen snapshot (symbol: TEST-NO-REAL-ASSET)", as_of: "2026-10-10" },
      { claim: "b", source: "facts.debt_to_equity in frozen snapshot (symbol: TEST-NO-REAL-ASSET)", as_of: "2026-10-10" },
      { claim: "c", source: "observed_at and synthetic fields in frozen snapshot (symbol: TEST-NO-REAL-ASSET)", as_of: "2026-10-12" },
    ] }));
    expect(validateForecastCitations(forecast, snapshot).evidence_citations.map((c) => c.source)).toEqual(["facts.trend_score", "facts.debt_to_equity", "observed_at", "synthetic"]);
    // Prose that does not start with a real path is still rejected.
    const bad = parseForecast(JSON.stringify({ score: 50, confidence: 0.1, rationale: "r", bull_case: "b", bear_case: "c", evidence_citations: [{ claim: "x", source: "the growth figure in the snapshot", as_of: "unknown" }] }));
    expect(() => validateForecastCitations(bad, snapshot)).toThrow("model_citation_path_missing");
  });
});
