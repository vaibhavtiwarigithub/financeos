import { describe, expect, it } from "vitest";
import { scoreFundamentals, scoreSentiment } from "@/lib/data/scores";
import { shrinkSentimentScore } from "@/lib/social-sentiment";

describe("score input governance", () => {
  it("shrinks thin sentiment before a direct score reaches scoring", () => {
    expect(shrinkSentimentScore(100, 5, 10)).toBe(67);
    expect(shrinkSentimentScore(100, 30, 10)).toBe(88);
    expect(shrinkSentimentScore(50, 5, 10)).toBe(50);
    expect(scoreSentiment({ sentiment_score: 67 }).score).toBe(67);
  });

  it("records analyst targets without changing the fundamental score", () => {
    const base = {
      Symbol: "TEST",
      Sector: "Technology",
      PERatio: "20",
      ProfitMargin: "0.15",
      ReturnOnEquityTTM: "0.15",
      EPS: "3",
      QuarterlyRevenueGrowthYOY: "0.12",
    };
    const withoutTarget = scoreFundamentals(base, false, 100);
    const withTarget = scoreFundamentals({ ...base, AnalystTargetPrice: "200" }, false, 100);

    expect(withTarget.score).toBe(withoutTarget.score);
    expect(withTarget.evidence).toMatchObject({
      analyst_target: 200,
      analyst_upside_pct: 100,
      analyst_target_mode: "observational_only",
    });
  });
});

describe("unvalidated broker financial trends", () => {
  it("cannot change a trade-eligible fundamental score", () => {
    const base = {
      Symbol: "TEST",
      Sector: "Technology",
      PERatio: "20",
      ProfitMargin: "0.15",
      ReturnOnEquityTTM: "0.15",
      EPS: "3",
      QuarterlyRevenueGrowthYOY: "0.12",
    };
    const baseline = scoreFundamentals(base, false, 100);
    const withBrokerTrendFields = scoreFundamentals({
      ...base,
      RevenueAcceleration: "0.50",
      MarginTrend: "10",
    }, false, 100);

    expect(withBrokerTrendFields.score).toBe(baseline.score);
    expect(withBrokerTrendFields.evidence).not.toHaveProperty("revenue_acceleration");
    expect(withBrokerTrendFields.evidence).not.toHaveProperty("margin_trend");
  });
});
