import { describe, expect, it } from "vitest";
import { buildCouncilIcCell, extractJson, medianScore, parseForecast, sha256, validateForecastCitations } from "@/lib/llm-council/core";

describe("LLM council score contract", () => {
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
});
