// Performance Truth — P0 evaluation job.
// Deterministic, no LLM, no weight mutation, append-only output.
// Computes book metrics from closed paper_trades + paper_performance NAV.
// Opportunity-level metrics (opp_*) are P1 — filled as null here.

import {
  navToReturns, sharpe, sortino, maxDrawdown,
  expectancy, costNet, slip, calibration,
} from "@/lib/analytics/performance-metrics";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export interface EvaluationResult {
  ok: boolean;
  error?: string;
  n_trades_total?: number;
  n_trades_evaluable?: number;
  health_label?: string;
  health_reason?: string;
  book_sharpe?: number | null;
}

export async function runEvaluation(
  mandateId: string,
  market: string,
  supabase: SupabaseClient,
): Promise<EvaluationResult> {
  // 1. Fetch mandate — fail closed on any error
  const { data: mandate, error: mandateErr } = await supabase
    .from("investment_mandates")
    .select("*")
    .eq("id", mandateId)
    .single();
  if (mandateErr || !mandate) {
    return { ok: false, error: mandateErr?.message ?? "mandate not found" };
  }

  // 2. All closed trades for this mandate.
  //    paper_trades closes via closed_at (no status column).
  const { data: allTrades, error: tradesErr } = await supabase
    .from("paper_trades")
    .select(
      "pnl_pct, spread_applied, fill_price, realized_slip_pct, analyst_score, closed_at, tainted, excluded_from_learning",
    )
    .eq("mandate_id", mandateId)
    .eq("market", market)
    .not("closed_at", "is", null);
  if (tradesErr) return { ok: false, error: `trades: ${tradesErr.message}` };

  const trades = allTrades ?? [];
  const taintedCount = trades.filter((t) => t.tainted).length;
  const excludedCount = trades.filter(
    (t) => t.excluded_from_learning && !t.tainted,
  ).length;
  const evaluable = trades.filter(
    (t) => !t.tainted && !t.excluded_from_learning,
  );

  // Dataset hash for duplicate-run detection (stable sort by closed_at)
  const sorted = [...trades]
    .sort((a, b) => (a.closed_at < b.closed_at ? -1 : 1))
    .map((t) => t.closed_at as string);
  const datasetHash = createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 16);
  const windowStart = sorted.length ? sorted[0]?.slice(0, 10) ?? null : null;
  const windowEnd =
    sorted.length ? sorted[sorted.length - 1]?.slice(0, 10) ?? null : null;

  // 3. NAV series — whole-book (paper_performance has no mandate column).
  //    Sharpe/Sortino/MaxDD are whole-book metrics; document clearly.
  const { data: navRows, error: navErr } = await supabase
    .from("paper_performance")
    .select("date, nav, alpha_pct, bench_return_pct")
    .eq("market", market)
    .order("date");
  if (navErr) return { ok: false, error: `nav: ${navErr.message}` };

  // 4. Compute book metrics — reuse existing math, zero new math here.
  const returns = navToReturns((navRows ?? []).map((r) => r.nav));
  // expectancy() / costNet() / slip() take ClosedTrade[] with pnl_pct field directly
  const expM = expectancy(evaluable);
  const sharpeM = sharpe(returns);
  const sortM = sortino(returns);
  const maxDDM = maxDrawdown(returns);
  const costM = costNet(evaluable);
  const slipM = slip(evaluable);
  // calibration() expects { predicted: 0..1, win: boolean }
  const _calibM = calibration(
    evaluable.map((t) => ({
      predicted: Number(t.analyst_score ?? 50) / 100,
      win: (t.pnl_pct ?? 0) > 0,
    })),
  );
  const alphaPct =
    (navRows ?? []).length
      ? ((navRows ?? [])[navRows!.length - 1]?.alpha_pct ?? null)
      : null;

  // 5. P0 display health label — NOT a live-trading promotion gate.
  const n = evaluable.length;
  const MIN_EVAL = 20;
  let healthLabel = "insufficient_sample";
  let healthReason = `Need ${MIN_EVAL} evaluable trades, have ${n}`;

  if (n >= MIN_EVAL) {
    if (sharpeM.insufficient || (sharpeM.value ?? 0) <= 0) {
      healthLabel = "negative_or_zero_edge";
      healthReason = `Whole-book Sharpe ${sharpeM.insufficient ? "N/A (insufficient NAV)" : (sharpeM.value ?? 0).toFixed(2)} ≤ 0`;
    } else if ((sharpeM.value ?? 0) < 0.5) {
      healthLabel = "promising_but_unvalidated";
      healthReason = `Sharpe ${(sharpeM.value ?? 0).toFixed(2)} < 0.5 — run walk-forward validation`;
    } else {
      healthLabel = "validation_required";
      healthReason = `Sharpe ${(sharpeM.value ?? 0).toFixed(2)} ≥ 0.5 — confirm via walk-forward`;
    }
  }

  // 6. Persist (append-only — never upsert)
  const { error: insertErr } = await supabase.from("strategy_evaluations").insert({
    mandate_id:               mandateId,
    mandate_snapshot:         mandate,      // snapshot at evaluation time
    market,
    evaluator_version:        process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    dataset_hash:             datasetHash,
    window_start:             windowStart,
    window_end:               windowEnd,
    n_trades_total:           trades.length,
    n_trades_evaluable:       n,
    tainted_count:            taintedCount,
    excluded_count:           excludedCount,
    // Book metrics — WHOLE-BOOK NAV; mandate-specific Sharpe is P1 (opp_* columns)
    book_sharpe:              sharpeM.insufficient ? null : sharpeM.value,
    book_sortino:             sortM.insufficient ? null : sortM.value,
    book_max_drawdown:        maxDDM.insufficient ? null : maxDDM.value,
    book_win_rate:            expM.insufficient ? null : expM.winRate,   // winRate is number|null
    book_expectancy_pct:      expM.insufficient ? null : expM.value,
    book_alpha_pct:           alphaPct,
    book_benchmark_symbol:    mandate.benchmark_symbol,
    book_cost_adjusted_return_pct: costM.netReturnPct.insufficient ? null : costM.netReturnPct.value,
    book_slip_vs_modeled_bps: slipM.insufficient ? null : (slipM.value ?? 0) * 10000,
    // Opportunity-level metrics: P1 (decision_observations × observation_labels)
    opp_n_labeled:            null,
    opp_hit_rate:             null,
    opp_benchmark_neutral_expectancy: null,
    opp_ic:                   null,
    opp_t_stat:               null,
    // edge_universe_members is NOT PIT-safe (current-liquid/survivorship-biased)
    universe_pit_safe:        false,
    // Walk-forward: null until validation_experiments run referencing this mandate (P1)
    validation_experiment_id: null,
    walk_forward_folds:       null,
    health_label:             healthLabel,
    health_reason:            healthReason,
    promotion_eligible:       false,   // P0: always false; P1 LearnerAgent sets via new row
  });

  if (insertErr) return { ok: false, error: `insert: ${insertErr.message}` };

  return {
    ok: true,
    n_trades_total:    trades.length,
    n_trades_evaluable: n,
    health_label:      healthLabel,
    health_reason:     healthReason,
    book_sharpe:       sharpeM.insufficient ? null : sharpeM.value,
  };
}
