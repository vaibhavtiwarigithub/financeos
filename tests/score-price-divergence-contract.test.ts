import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("score/price divergence integration contract", () => {
  const chart = readFileSync("components/dashboard/ScoreTrackerPanel.tsx", "utf8");
  const chartApi = readFileSync("app/api/charts/score-history/route.ts", "utf8");
  const route = readFileSync("app/api/agents/score-price-divergence/route.ts", "utf8");
  const migration = readFileSync("supabase/migrations/20260909015444_score_price_divergence_shadow.sql", "utf8");
  const legacy = readFileSync("app/api/agents/rescore-check/route.ts", "utf8");

  it("renders one-symbol price and every score dimension on separate axes", () => {
    expect(chart).toContain('dataKey="price_at_decision"');
    expect(chartApi).toContain('const key = `${row.market}:${row.symbol}:${session}`');
    expect(chartApi).toContain('q = q.eq("market", marketF)');
    expect(chartApi).toContain('session_source: technicalSession ? "technical_as_of" : "observation_date_fallback"');
    expect(chart).toContain('yAxisId="price"');
    expect(chart).toContain('yAxisId="scores"');
    for (const key of ["analyst_score", "fundamental_score", "technical_score", "sentiment_score", "macro_score", "insider_score"]) expect(chart).toContain(key);
    expect(chartApi).toContain('svc.from("decision_observations")');
    expect(chartApi).toContain('const key = `${row.market}:${row.symbol}:${session}`');
  });

  it("requires explicit market scope and removes global prose learning", () => {
    expect(route).toContain('market must be us or india');
    expect(route).toContain('.eq("market", market)');
    expect(route).not.toContain('from("learning_log")');
    expect(legacy).toContain("score-price-divergence/route");
    expect(legacy).not.toContain("UNDERSCORED");
  });

  it("keeps evidence append-only, explicitly granted, and out of money paths", () => {
    expect(migration).toContain("before update or delete");
    expect(migration).toContain("before truncate");
    expect(migration).toContain("grant select, insert on public.score_price_divergence_runs");
    expect(migration).toContain("kairos-score-price-divergence-us");
    expect(migration).toContain("kairos-score-price-divergence-india");
    for (const forbidden of ["paper_positions", "paper_trades", "broker_orders", "strategy_config"]) expect(route).not.toContain(forbidden);
  });
});
