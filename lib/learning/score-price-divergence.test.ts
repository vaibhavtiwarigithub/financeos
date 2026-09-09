import { describe, expect, it } from "vitest";
import { buildDivergenceEvents, normalizeDivergenceObservations, summarizeDivergenceOutcomes, type DivergenceInput } from "./score-price-divergence";

function row(id: number, session: string, score: number, price: number, overrides: Partial<DivergenceInput> = {}): DivergenceInput {
  return {
    id, ts: `${session}T15:00:00Z`, market: "us", symbol: "INTC",
    analyst_score: score, fundamental_score: score, technical_score: score,
    sentiment_score: score, macro_score: score, insider_score: score,
    price_at_decision: price, features: { technical: { as_of: session } },
    availability_mask: { fundamental: true, technical: true, sentiment: true, macro: true, insider: true },
    weights_used: { fundamental: 0.3, technical: 0.3, sentiment: 0.2, macro: 0.1, insider: 0.1 },
    score_source: "deterministic_v1", scoring_version: "v1.0", ...overrides,
  };
}

describe("score/price divergence measurement", () => {
  it("measures five research sessions even when the symbol is rescored daily", () => {
    const input = [
      row(1, "2026-09-01", 70, 100), row(2, "2026-09-02", 69, 100.5),
      row(3, "2026-09-03", 67, 101), row(4, "2026-09-04", 66, 101.5),
      row(5, "2026-09-05", 64, 103),
    ];
    const { points } = normalizeDivergenceObservations(input, "us");
    const primary = buildDivergenceEvents(points).find(event => event.isPrimary);
    expect(primary).toMatchObject({ direction: "falling_score_rising_price", windowSessions: 5, startObservationId: 1, endObservationId: 5 });
    expect(primary?.priceReturnPct).toBeCloseTo(3);
  });

  it("keeps markets separate and deterministically keeps the latest same-session observation", () => {
    const { points, exclusions } = normalizeDivergenceObservations([
      row(1, "2026-09-01", 70, 100),
      row(2, "2026-09-01", 68, 101, { ts: "2026-09-01T20:00:00Z" }),
      row(3, "2026-09-01", 10, 10, { market: "india" }),
    ], "us");
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ id: 2, score: 68, price: 101, market: "us" });
    expect(exclusions).toMatchObject({ duplicate_symbol_session: 1, wrong_market: 1 });
  });

  it("fails closed on missing technical provenance and availability", () => {
    const result = normalizeDivergenceObservations([
      row(1, "2026-09-01", 70, 100, { features: {} }),
      row(2, "2026-09-02", 69, 101, { availability_mask: { technical: false } }),
    ], "us");
    expect(result.points).toHaveLength(0);
    expect(result.exclusions).toMatchObject({ missing_technical_session: 1, technical_unavailable: 1 });
  });

  it("does not compare endpoints across a scoring version, mask, or weight change", () => {
    const base = [1, 2, 3, 4, 5].map((id, index) => row(id, `2026-09-0${id}`, 70 - index * 2, 100 + index));
    for (const changed of [
      { scoring_version: "v2.0" },
      { availability_mask: { fundamental: false, technical: true, sentiment: true, macro: true, insider: true } },
      { weights_used: { fundamental: 0.1, technical: 0.5, sentiment: 0.2, macro: 0.1, insider: 0.1 } },
    ]) {
      const rows = [...base.slice(0, 4), { ...base[4], ...changed }];
      expect(buildDivergenceEvents(normalizeDivergenceObservations(rows, "us").points).some(event => event.isPrimary)).toBe(false);
    }
    const intermediateChange = [...base];
    intermediateChange[2] = { ...intermediateChange[2], scoring_version: "v2.0" };
    expect(buildDivergenceEvents(normalizeDivergenceObservations(intermediateChange, "us").points).some(event => event.isPrimary)).toBe(false);
  });

  it("detects the inverse direction and summarizes benchmark-neutral outcomes", () => {
    const rows = [1, 2, 3, 4, 5].map((id, index) => row(id, `2026-09-0${id}`, 50 + index * 2, 100 - index));
    expect(buildDivergenceEvents(normalizeDivergenceObservations(rows, "us").points).find(event => event.isPrimary)?.direction).toBe("rising_score_falling_price");
    const summary = summarizeDivergenceOutcomes([
      { direction: "rising_score_falling_price", horizon_days: 5, benchmark_neutral_return: 0.03, end_session: "2026-09-05" },
      { direction: "rising_score_falling_price", horizon_days: 5, benchmark_neutral_return: -0.01, end_session: "2026-09-06" },
    ]);
    expect(summary["rising_score_falling_price:h5"]).toMatchObject({ events: 2, distinct_sessions: 2, positive_share: 0.5 });
    expect(summary["rising_score_falling_price:h5"].mean_benchmark_neutral_return).toBeCloseTo(0.01);
  });
});
