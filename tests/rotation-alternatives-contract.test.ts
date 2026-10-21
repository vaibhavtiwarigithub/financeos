import { afterEach, describe, expect, it, vi } from "vitest";
import { recordCapitalRotationShadow } from "@/lib/trading/capital-rotation";

afterEach(() => vi.useRealTimers());

describe("complete rotation source contract", () => {
  it.each((["us", "india"] as const).flatMap(market => ["lots", "stale", "null"].map(failure => ({ market, failure }))))(
    "checks another source when the weakest fails $failure evidence ($market)", async ({ market, failure }) => {
    vi.useFakeTimers();
    const now = new Date("2026-10-21T12:00:00Z");
    vi.setSystemTime(now);
    const suffix = market === "india" ? ".NS" : "";
    const weak = `WEAK${suffix}`, next = `NEXT${suffix}`, candidate = `NEW${suffix}`;
    const positions = [weak, next].map((symbol, i) => ({ id: `position${i}`, symbol, market, qty: 10, avg_cost: 100,
      current_price: 100, opened_at: "2026-10-01T12:00:00Z", updated_at: now.toISOString(),
      price_target: 130, stop_loss: 80, exit_reason: null, resolved_horizon_days: 1, position_role: "alpha" }));
    const observations = Array.from({ length: 22 }, (_, i) => {
      const ts = new Date(Date.UTC(2026, 8, i + 1)).toISOString();
      return [
        { id: i * 2, market, ts, symbol: candidate, analyst_score: 90, entry_eligible: true, direction: "long",
          decision_context: "entry_candidate", discovery_source: "screener_momentum",
          observation_labels: [{ horizon_days: 1, fwd_return: 0.02 + Math.sin(i) * 0.001 }] },
        { id: i * 2 + 1, market, ts, symbol: weak, analyst_score: 50, entry_eligible: false, direction: "long",
          decision_context: "holding_review", discovery_source: "holding",
          observation_labels: [{ horizon_days: 1, fwd_return: 0 }] },
      ];
    }).flat();
    const datasets: Record<string, any[]> = {
      rotation_config: [{ market, book_type: "paper", rotation_shadow_enabled: true, rotation_margin_score: 12, rotation_persistence_runs: 1 }],
      paper_positions: positions,
      agent_signals: [...[weak, next].map((symbol, i) => ({ id: i, market, symbol,
        analyst_score: i === 0 && failure === "null" ? null : 61 + i * 4,
        session_validated: true, is_holding: true,
        created_at: i === 0 && failure === "stale" ? "2026-10-15T12:00:00Z" : now.toISOString() })),
        ...(failure === "null" ? [{ id: 9, market, symbol: weak, analyst_score: 61, session_validated: true,
          is_holding: true, created_at: "2026-10-20T12:00:00Z" }] : [])],
      investment_mandates: [{ market, active: true, turnover_budget_monthly: 100, tax_sensitivity: "medium" }],
      rotation_events: [], decision_observations: observations, paper_trades: [],
      paper_order_events: [{ id: 1, market, symbol: next, created_at: positions[1].opened_at,
        event_type: "fill", side: "buy", qty: 10, fill_price: 100, fill_status: "filled" }],
      returns: Array.from({ length: 65 }, (_, i) => [weak, next, candidate].map((symbol, j) => ({ symbol,
        session_date: new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10),
        simple_return: Math.sin(i * (j + 1) * 0.7) / 100 }))).flat(),
    };
    const writes: any[] = [];
    const builder = (name: string) => {
      let rows = [...datasets[name]];
      const q: any = {
        select: () => q,
        eq: (key: string, value: unknown) => { if (!key.includes(".")) rows = rows.filter(row => row[key] === value); return q; },
        in: (key: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[key])); return q; },
        gte: (key: string, value: string) => { rows = rows.filter(row => row[key] >= value); return q; },
        order: () => q,
        limit: (count: number) => { rows = rows.slice(0, count); return q; },
        range: (from: number, to: number) => { rows = rows.slice(from, to + 1); return q; },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        insert: async (row: any) => { writes.push(row); return { error: null }; },
        then: (resolve: any) => resolve({ data: rows, error: null, count: rows.length }),
      };
      return q;
    };
    const result = await recordCapitalRotationShadow({ from: builder, rpc: () => builder("returns") }, {
      runId: "test-run", candidate: { signalId: "signal", symbol: candidate, market,
        currency: market === "india" ? "INR" : "USD", score: 90, targetNotional: 1_000, cash: 0,
        fillPrice: 100, sector: "technology" },
      scoreThreshold: 60, minHoldingDays: 2, resolvedHorizonDays: 1, maxSignalAgeSessions: 2,
      exitHysteresis: 10, portfolioNav: 10_000, existingPositionsPolicy: "apply",
      book: [weak, next].map(symbol => ({ symbol, sector: "healthcare", valuePct: 10, beta: null, dailyVol: null })),
    });
    expect(result.readiness.ready, result.readiness.blockers.join(",")).toBe(true);
    expect(result.plan?.sourceId).toBe("position1");
    expect(writes).toHaveLength(1);
    if (failure !== "lots") expect(writes[0].gate_results_json.source_reject_counts.missing_fresh_score).toBe(1);
    expect(writes[0].gate_results_json.source_alternatives).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_symbol: weak, ready: false, blockers: expect.arrayContaining(["exact_tax_lots_unavailable"]) }),
      expect.objectContaining({ source_symbol: next, ready: true, blockers: [] }),
    ]));
  });
});
