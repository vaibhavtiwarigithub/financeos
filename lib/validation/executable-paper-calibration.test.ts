import { describe, expect, it } from "vitest";
import { marketSessionDateAt } from "@/lib/shadows/paper-lot-replay-events";
import {
  buildExecutablePaperObservations,
  executableTradeWalkForwardFolds,
  fitExecutablePaperCalibration,
  type ExecutablePaperObservation,
  type ExecutablePaperTradeSourceRow,
} from "@/lib/validation/executable-paper-calibration";

function source(overrides: Partial<ExecutablePaperTradeSourceRow> = {}): ExecutablePaperTradeSourceRow {
  return {
    id: "lot-1", market: "us", symbol: "ABC", order_side: "buy", qty: 10, fill_price: 100,
    signal_id: "signal-1", paper_event_id: "event-1", executed_at: "2026-01-02T15:00:00.000Z",
    closed_at: "2026-01-05T15:00:00.000Z", exit_price: 102, realized_pnl: 20,
    analyst_score: 65, resolved_horizon_days: 10, mandate_version: 3,
    mandate_snapshot: {
      executable_outcome_contract: "executable_paper_trade_pnl_v1",
      entry_score_source: "deterministic_v1",
      entry_score_dimensions: { fundamental_score: 60, technical_score: 70, sentiment_score: 55, macro_score: 50, insider_score: 50 },
    },
    position_role: "alpha", partial_exit_lot: false, tainted: false, excluded_from_learning: false,
    ...overrides,
  };
}

function marketDays(count: number): string[] {
  const dates: string[] = [];
  const date = new Date(Date.UTC(2024, 0, 1));
  while (dates.length < count) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function observations(count: number): ExecutablePaperObservation[] {
  return marketDays(count).map((session, i) => {
    const executedAt = `${session}T15:00:00.000Z`;
    const exitAt = `${session}T20:00:00.000Z`;
    return {
      id: i + 1, ts: executedAt, exitTs: exitAt,
      entrySession: marketSessionDateAt(executedAt, "us"), exitSession: marketSessionDateAt(exitAt, "us"),
      market: "us", symbol: `S${i}`, analyst_score: 60,
      fundamental_score: i % 20 < 10 ? 70 : 30,
      technical_score: i % 20 < 10 ? 70 : 30, sentiment_score: 60, macro_score: 60, insider_score: 60,
      returnPct: i % 20 < 10 ? (i % 10 < 6 ? 0.02 : -0.01) : (i % 10 < 4 ? 0.02 : -0.01),
      won: i % 20 < 10 ? (i % 10 < 6 ? 1 : 0) : (i % 10 < 4 ? 1 : 0),
    };
  });
}

describe("executable paper trade outcome cohort", () => {
  it("aggregates closed partial exits to one original entry return", () => {
    const rows = [
      source({ id: "sold-slice", qty: 4, realized_pnl: 12, exit_price: 103, partial_exit_lot: false }),
      source({ id: "residual", qty: 6, realized_pnl: 18, exit_price: 103, partial_exit_lot: true }),
    ];
    const result = buildExecutablePaperObservations(rows, "us", 10, 3);
    expect(result).toHaveLength(1);
    expect(result[0].returnPct).toBeCloseTo(0.03);
    expect(result[0].won).toBe(1);
  });

  it("excludes open, tainted, mismatched-mandate and ambiguous-lot cohorts", () => {
    const rows = [
      source({ id: "open", closed_at: null }),
      source({ id: "tainted", paper_event_id: "event-2", tainted: true }),
      source({ id: "wrong-mandate", paper_event_id: "event-3", mandate_version: 2 }),
      source({ id: "ambiguous-1", paper_event_id: "event-4" }),
      source({ id: "ambiguous-2", paper_event_id: "event-4", partial_exit_lot: false }),
    ];
    expect(buildExecutablePaperObservations(rows, "us", 10, 3)).toEqual([]);
  });

  it("purges training outcomes that had not closed before the next test fold", () => {
    const rows = observations(650);
    const crossed = rows.map((row) => ({ ...row, exitSession: row.entrySession }));
    const folds = executableTradeWalkForwardFolds(crossed, 10, marketDays(650));
    expect(folds.length).toBe(5);
    for (const fold of folds) {
      const testStart = fold.test[0].entrySession;
      expect(fold.train.every((row) => row.exitSession < testStart)).toBe(true);
    }
  });

  it("does not qualify until OOS observations, independent blocks, both classes, and calibration pass", () => {
    const fit = fitExecutablePaperCalibration(observations(650), 10, 3, marketDays(650));
    expect(fit).not.toBeNull();
    expect(fit!.evidence.validation.oos_sample_count).toBeGreaterThanOrEqual(250);
    expect(fit!.evidence.validation.independent_horizon_blocks).toBeGreaterThanOrEqual(50);
    expect(fit!.evidence.validation.accepted).toBe(true);
    expect(fit!.evidence.payoff_ratio).toBeCloseTo(2);
    expect(fit!.datasetHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
