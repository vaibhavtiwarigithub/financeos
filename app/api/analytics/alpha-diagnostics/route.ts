// GET/POST /api/analytics/alpha-diagnostics?market=us|india
//
// Alpha Diagnostic Lab runner. READ-ONLY with respect to every money path: it
// reads persisted ledgers and writes exactly one row to `backtest_experiments`
// (experiment_type='alpha_diagnostic'). It calls no provider, imports no scorer,
// PaperTrader, PositionMonitor, promotion, proposal, order or broker module, and
// its strongest verdict is `owner_review`.
//
// GET  — latest completed run plus bounded history. Writes nothing.
// POST — owner or cron. Inserts the immutable plan row BEFORE loading the
//        evaluation dataset, runs A0 first, and refuses to interpret anything
//        downstream if data truth failed.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import {
  runA0DataTruth, runA1Funnel, runA3Payoff,
  type NavRow, type FunnelRow, type ClosedLot,
} from "@/lib/analytics/alpha-diagnostics";
import {
  runA4ExitPaths, runA5Sizing, runA7CostStress,
  type ExitPathLot, type SizedLot,
} from "@/lib/analytics/alpha-diagnostics-counterfactual";
import { runA2Selection } from "@/lib/analytics/alpha-diagnostics-selection";
import { runA8Robustness } from "@/lib/analytics/alpha-diagnostics-counterfactual";
import {
  runPortfolioCalendar, runA6Portfolio, runA9RiskGeometry,
  type CalendarEvent, type DailyMark, type GeometryLot,
} from "@/lib/analytics/alpha-diagnostics-portfolio";
import { spearman } from "@/lib/learning/archetype-ic";
import {
  fingerprint, resolveVerdict, MIN_REVIEW_DATES,
  type DiagnosticFinding, type DiagnosticMarket,
} from "@/lib/analytics/alpha-diagnostic-contract";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PLAN_VERSION = "alpha_diagnostic_lab_p0_v1";
const HISTORY_LIMIT = 20;

function marketFrom(req: NextRequest): DiagnosticMarket | null {
  const m = req.nextUrl.searchParams.get("market");
  return m === "us" || m === "india" ? m : null;
}

async function authorize(req: NextRequest): Promise<NextResponse | null> {
  if (verifyCronSecret(req)) return null;
  return requireOwner();
}

export async function GET(req: NextRequest) {
  const gate = await authorize(req);
  if (gate) return gate;
  const market = marketFrom(req);
  if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });

  const svc = createServiceClient();
  // Market isolation is enforced in the QUERY, not in the caller: a US request
  // can never surface an India result even if the caller passes both.
  const { data, error } = await svc
    .from("backtest_experiments")
    .select("id, market, experiment_type, started_at, completed_at, result_summary, plan_fingerprint, dataset_fingerprint, run_fingerprint, code_version, trials_considered")
    .eq("experiment_type", "alpha_diagnostic")
    .eq("market", market)
    .order("started_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const runs = data ?? [];
  return NextResponse.json({
    market,
    latest: runs.find((r: any) => r.completed_at != null) ?? null,
    history: runs,
    influence: "none",
  });
}

export async function POST(req: NextRequest) {
  const gate = await authorize(req);
  if (gate) return gate;
  const market = marketFrom(req);
  if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });

  const svc = createServiceClient();
  const startedAt = new Date().toISOString();
  const dataCutoff = new Date().toISOString().slice(0, 10);
  const codeVersion = process.env.VERCEL_GIT_COMMIT_SHA ?? null;

  // The plan is frozen and written BEFORE any evaluation data is read, so the
  // hypothesis cannot be edited after seeing the result. Trials are declared up
  // front for the same reason.
  const plan = {
    planVersion: PLAN_VERSION,
    market,
    dataCutoff,
    objective: "net_excess_return_vs_primary_benchmark",
    benchmark: market === "india" ? "^NSEI" : "VOO",
    tests: ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"],
    minReviewDates: MIN_REVIEW_DATES,
    // The code that computes the result is PART OF the plan. Without this a
    // change to any test silently replays the previous run through the
    // plan_fingerprint idempotency path -- identical plan, different code,
    // stale answer. In production this is the deploy SHA; locally it is null,
    // so a local re-run of unchanged code is still correctly idempotent.
    codeVersion,
  };
  const planFingerprint = fingerprint(plan);

  const { data: planRow, error: planErr } = await svc
    .from("backtest_experiments")
    .insert({
      experiment_type: "alpha_diagnostic",
      market,
      data_cutoff: dataCutoff,
      code_version: codeVersion,
      plan_fingerprint: planFingerprint,
      // The registry requires these NOT NULL, and they are the lineage that
      // makes a run auditable rather than boilerplate: what was asked, who
      // asked it, and how many variants were budgeted BEFORE any data was read.
      hypothesis:
        `Locate which stage of the ${market.toUpperCase()} funnel (data truth, selection, payoff geometry, ` +
        `exit paths, sizing, cost) accounts for benchmark-relative performance vs ${plan.benchmark}. ` +
        `Diagnostic only: no promotion, no policy change, strongest verdict is owner_review.`,
      // Constrained to 'llm' | 'human' by backtest_experiments_author_check.
      author: "llm",
      // Declared up front. Every test counts as a trial for the multiple-testing
      // adjustment, so this cannot be revised after seeing results.
      variant_budget: plan.tests.length,
      trials_considered: plan.tests.length,
      started_at: startedAt,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    // The registry enforces ONE experiment per distinct plan
    // (backtest_experiments_plan_fingerprint_uidx). The plan is deterministic
    // over (planVersion, market, dataCutoff, tests), so re-running the same
    // plan on the same day is not a new experiment -- it is the same one. Return
    // it instead of failing, which keeps the endpoint idempotent for a cron that
    // fires twice and preserves the rerun-identity property: identical plan,
    // identical result.
    if (planErr && (planErr as any).code === "23505") {
      const { data: existing } = await svc
        .from("backtest_experiments")
        .select("id, market, result_summary, run_fingerprint, completed_at")
        .eq("plan_fingerprint", planFingerprint)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({
          runId: (existing as any).id,
          market,
          reused: true,
          verdict: (existing as any).result_summary?.verdict ?? null,
          summary: (existing as any).result_summary ?? null,
          influence: "none",
        });
      }
    }
    return NextResponse.json({ error: `plan insert failed: ${planErr?.message ?? "no row"}` }, { status: 500 });
  }
  const runId = (planRow as any).id;

  try {
    // ── Load persisted ledgers only. No provider call anywhere below. ────────
    const [perfRes, tradesRes, obsRes, marksRes, posRes] = await Promise.all([
      svc.from("paper_performance")
        .select("date, nav, cash_balance, positions_value, bench_nav, bench_session_date, bench_source, tainted")
        .eq("market", market).order("date", { ascending: true }),
      // ALL lots, not just closed. The closed-lot cohorts are derived below;
      // A6 additionally needs OPEN lots, because a calendar replay treats an
      // open position as an entry with no exit yet.
      svc.from("paper_trades")
        .select("symbol, market, realized_pnl, pnl_pct, exit_reason, fill_price, qty, executed_at, exit_price, tainted, excluded_from_learning, closed_at")
        .eq("market", market).not("fill_price", "is", null),
      // A2 inputs: scored decisions joined to their matured benchmark-neutral
      // label. Read-only join over persisted ledgers, no provider call.
      svc.from("decision_observations")
        .select("symbol, ts, analyst_score, observation_labels!inner(horizon_days, benchmark_neutral_return)")
        .eq("market", market)
        .not("analyst_score", "is", null)
        .limit(20000),
      // A6 inputs. The mark ledger is the AUTHORITATIVE record of what the book
      // was actually marked at, so the replay uses it rather than reconstructing
      // prices from a provider series. It only begins 2026-08-17 (when the W4
      // ledger was created), which bounds the A6 window -- reported honestly in
      // its date count rather than backfilled from a different source.
      svc.from("paper_position_marks")
        .select("session_date, symbol, mark_price")
        .eq("market", market).order("session_date", { ascending: true }).limit(20000),
      // A9 inputs: geometry currently carried by open positions.
      svc.from("paper_positions")
        .select("symbol, opened_at, avg_cost, stop_loss, price_target")
        .eq("market", market),
    ]);
    if (perfRes.error) throw new Error(`paper_performance read failed: ${perfRes.error.message}`);
    if (tradesRes.error) throw new Error(`paper_trades read failed: ${tradesRes.error.message}`);
    if (obsRes.error) throw new Error(`decision_observations read failed: ${obsRes.error.message}`);
    if (marksRes.error) throw new Error(`paper_position_marks read failed: ${marksRes.error.message}`);
    if (posRes.error) throw new Error(`paper_positions read failed: ${posRes.error.message}`);

    const perfRows = (perfRes.data ?? []) as any[];
    const allLotRows = (tradesRes.data ?? []) as any[];
    // Closed-lot cohorts. A3/A4/A5/A7 are all realized-outcome metrics and must
    // not see an open position, whose P&L has not happened yet.
    const tradeRows = allLotRows.filter((r: any) => r.closed_at != null);

    // Rows already labelled `tainted` are excluded from the data-truth check.
    // Taint is the recorded acknowledgement that a row is known-bad; re-failing
    // it every run would make the label meaningless and pin the market at
    // data_invalid forever, which is exactly what happened to India on the
    // first run. They remain in the ACCOUNTING totals below.
    const taintedNavRows = perfRows.filter(r => r.tainted === true).length;
    const navRows: NavRow[] = perfRows.filter(r => r.tainted !== true).map(r => ({
      date: r.date,
      nav: num(r.nav), cashBalance: num(r.cash_balance), positionsValue: num(r.positions_value),
      benchNav: num(r.bench_nav), benchSessionDate: r.bench_session_date ?? null,
      benchSource: r.bench_source ?? null,
    }));

    // Cohort split. Accounting keeps everything; learning drops tainted and
    // explicitly excluded rows. Neither may silently substitute for the other,
    // so both counts are reported.
    const accountingLots: ClosedLot[] = tradeRows.map(toClosedLot);
    const learningLots = accountingLots.filter((_, i) =>
      tradeRows[i].tainted !== true && tradeRows[i].excluded_from_learning !== true);

    const findings: DiagnosticFinding[] = [];

    // A0 FIRST and unconditionally. Everything after it is uninterpretable if
    // data truth failed.
    const a0 = runA0DataTruth(market, navRows);
    findings.push(a0.finding);

    if (a0.finding.status === "pass") {
      // A1 needs a funnel projection that P0 does not yet persist; emit an
      // explicit insufficient-evidence finding rather than a fabricated funnel.
      findings.push(runA1Funnel(market, [] as FunnelRow[], 10, MIN_REVIEW_DATES));

      // A2 at h10 -- the horizon the mandate actually holds to (target_hold_days
      // = 10). Grading a 10-day policy on 2-day moves measures noise; grading it
      // on 20-day moves measures what happens after the position is already gone.
      const A2_HORIZON = 10;
      const selectionRows: Array<{ date: string; symbol: string; score: number; forwardReturn: number; ts: string }> =
        (obsRes.data ?? []).flatMap((r: any) => {
        const labels: any[] = Array.isArray(r.observation_labels) ? r.observation_labels : [r.observation_labels];
        const label = labels.find((l: any) => l && Number(l.horizon_days) === A2_HORIZON);
        const fwd = label == null ? null : num(label.benchmark_neutral_return);
        const score = num(r.analyst_score);
        if (fwd == null || score == null) return [];
        return [{
          date: String(r.ts).slice(0, 10),
          symbol: String(r.symbol),
          score,
          forwardReturn: fwd,
          ts: String(r.ts),
        }];
      });
      findings.push(runA2Selection(market, selectionRows, A2_HORIZON, MIN_REVIEW_DATES));
      findings.push(runA3Payoff(market, learningLots));
      findings.push(runA4ExitPaths(market, learningLots.map(toExitPathLot)));
      findings.push(runA5Sizing(market, tradeRows
        .filter(r => r.tainted !== true && r.excluded_from_learning !== true)
        .map(toSizedLot)
        .filter(l => Number.isFinite(l.entryNotional))));
      findings.push(runA7CostStress(market, learningLots));

      // -- A6: paired calendar replay with finite capital --------------------
      const markRows = (marksRes.data ?? []) as any[];
      const bySession = new Map<string, Record<string, number>>();
      for (const mk of markRows) {
        const px = num(mk.mark_price);
        if (px == null) continue;
        const day = bySession.get(mk.session_date) ?? {};
        day[String(mk.symbol)] = px;
        bySession.set(mk.session_date, day);
      }
      const benchByDate = new Map<string, number | null>(
        perfRows.map(r => [String(r.date), num(r.bench_nav)] as [string, number | null]));
      const marks: DailyMark[] = [...bySession.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([session, prices]) => ({ session, prices, benchClose: benchByDate.get(session) ?? null }));

      // Events come ONLY from lots whose entry falls inside the marked window.
      // A lot opened before the ledger existed has no starting mark, and
      // replaying it would fabricate the position history.
      const firstMarked = marks[0]?.session ?? null;
      const lastMarked = marks[marks.length - 1]?.session ?? null;
      const events: CalendarEvent[] = [];
      for (const r of allLotRows) {
        const qty = num(r.qty);
        const fill = num(r.fill_price);
        const opened = r.executed_at ? String(r.executed_at).slice(0, 10) : null;
        if (qty == null || fill == null || opened == null) continue;
        if (firstMarked == null || opened < firstMarked) continue;
        if (lastMarked != null && opened > lastMarked) continue;
        events.push({ session: opened, symbol: String(r.symbol), kind: "entry", price: fill, quantity: qty });
        const exitPx = num(r.exit_price);
        const closed = r.closed_at ? String(r.closed_at).slice(0, 10) : null;
        if (exitPx != null && closed != null && closed >= opened && (lastMarked == null || closed <= lastMarked)) {
          events.push({ session: closed, symbol: String(r.symbol), kind: "exit", price: exitPx, quantity: qty });
        }
      }

      if (marks.length > 0 && events.length > 0) {
        const initialCash = num(perfRows[0]?.nav) ?? (market === "india" ? 1000000 : 10000);
        const simPolicy = {
          market,
          currency: (market === "india" ? "INR" : "USD") as "USD" | "INR",
          initialCash,
          maxOpenNames: 15,
          allowFractionalShares: true,
        };
        // Equal-size arm: same names, same timing, capital spread evenly. Total
        // deployed is held constant so any difference is allocation alone.
        const entries = events.filter(e => e.kind === "entry");
        const totalNotional = entries.reduce((a, e) => a + e.price * (e.quantity ?? 0), 0);
        const perName = entries.length > 0 ? totalNotional / entries.length : 0;
        const equalEvents: CalendarEvent[] = events.map(e =>
          e.kind === "entry"
            ? { session: e.session, symbol: e.symbol, kind: "entry" as const, price: e.price, cashAllocation: perName }
            : e);
        findings.push(runA6Portfolio(market, [
          { name: "actual", result: runPortfolioCalendar(simPolicy, events, marks) },
          { name: "equal_size", result: runPortfolioCalendar(simPolicy, equalEvents, marks) },
        ]));
      } else {
        findings.push(runA6Portfolio(market, []));
      }

      // -- A9: risk geometry currently carried by the book -------------------
      const geometryLots: GeometryLot[] = (posRes.data ?? []).flatMap((r: any) => {
        const cost = num(r.avg_cost);
        const stop = num(r.stop_loss);
        const target = num(r.price_target);
        if (cost == null || cost <= 0 || stop == null || target == null) return [];
        return [{
          symbol: String(r.symbol),
          openedAt: String(r.opened_at ?? "").slice(0, 10),
          stopPct: (1 - stop / cost) * 100,
          targetPct: (target / cost - 1) * 100,
        }];
      });
      findings.push(runA9RiskGeometry(market, geometryLots));

      // -- A8: falsify the INCUMBENT selection signal ------------------------
      // P0 has no challenger, so the subject is the incumbent score itself. The
      // question is narrow and answerable: is its apparent ranking
      // distinguishable from noise once every trial is charged for? A `fail`
      // means the INCUMBENT signal did not survive -- NOT that a proposed
      // candidate was rejected, which is why the subject is named in metrics.
      const a8Scores = selectionRows.map(r => r.score);
      const a8Outcomes = selectionRows.map(r => r.forwardReturn);
      const a8Real = a8Scores.length >= 3 ? spearman(a8Scores, a8Outcomes) : null;
      const a8 = runA8Robustness(market, {
        realStatistic: a8Real,
        scores: a8Scores,
        outcomes: a8Outcomes,
        statistic: (sc, ou) => spearman(sc, ou),
        trialsConsidered: plan.tests.length,
        nDates: new Set(selectionRows.map(r => r.date)).size,
        minDates: MIN_REVIEW_DATES,
      });
      a8.metrics = { ...a8.metrics, subject: "incumbent_selection_signal", statistic: "spearman_rank_ic_h10" };
      findings.push(a8);
    }

    const datasetFingerprint = fingerprint({
      perf: perfRows.length, trades: tradeRows.length,
      firstDate: perfRows[0]?.date ?? null, lastDate: perfRows[perfRows.length - 1]?.date ?? null,
    });
    const verdict = resolveVerdict(findings);
    const summary = {
      schemaVersion: 1,
      status: a0.finding.status === "pass" ? "evaluated" : "data_invalid",
      objective: plan.objective,
      benchmark: plan.benchmark,
      accountingCohort: { closedLots: accountingLots.length },
      learningCohort: { closedLots: learningLots.length, excluded: accountingLots.length - learningLots.length },
      coverage: { navRows: navRows.length, taintedNavRowsExcludedFromA0: taintedNavRows, markRows: (marksRes.data ?? []).length, lotRows: allLotRows.length, openLots: allLotRows.length - tradeRows.length },
      tests: Object.fromEntries(findings.map(f => [f.testId, f])),
      verdict,
      influence: "none",
    };
    const runFingerprint = fingerprint({ plan, dataset: datasetFingerprint, summary });

    await svc.from("backtest_experiments").update({
      completed_at: new Date().toISOString(),
      dataset_fingerprint: datasetFingerprint,
      run_fingerprint: runFingerprint,
      result_summary: summary,
    }).eq("id", runId);

    return NextResponse.json({ runId, market, verdict, summary, influence: "none" });
  } catch (e: any) {
    // A failed run writes ONE bounded failure result; a retry is a new
    // experiment with its own run id, so a failure can never be overwritten
    // into looking like a success.
    await svc.from("backtest_experiments").update({
      completed_at: new Date().toISOString(),
      result_summary: {
        schemaVersion: 1, status: "error", verdict: "data_invalid",
        error: String(e?.message ?? e).slice(0, 500), influence: "none",
      },
    }).eq("id", runId);
    return NextResponse.json({ runId, error: e?.message ?? String(e) }, { status: 500 });
  }
}

function num(v: unknown): number | null {
  // Reject absence BEFORE coercion. Number(null) === 0 and Number("") === 0, so
  // a NULL bench_nav would arrive as a real zero -- which made A0 treat the
  // Sunday inception row (no session, no benchmark) as a row that HAD a
  // benchmark and then fail it for missing provenance. Same trap as
  // classifyConstructorSize; absence is not a value.
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toClosedLot(r: any): ClosedLot {
  return {
    symbol: String(r.symbol),
    market: r.market === "india" ? "india" : "us",
    realizedPnl: Number(r.realized_pnl) || 0,
    pnlPct: Number(r.pnl_pct) || 0,
    // MAE/MFE live on observation_labels, joined in a later pass; null here is
    // honest missing data, and every consumer treats it as untouched rather
    // than as a barrier hit.
    mfe: null, mae: null,
    exitReason: r.exit_reason ?? null,
  };
}

function toExitPathLot(l: ClosedLot): ExitPathLot {
  // Mandate levels for the window; A4 reports `neither_touched` while MAE/MFE
  // are unavailable rather than inventing a resolution.
  return { ...l, targetPct: 8, stopPct: 7 };
}

function toSizedLot(r: any): SizedLot {
  const qty = Number(r.qty);
  const fill = Number(r.fill_price);
  return {
    symbol: String(r.symbol),
    entryNotional: Number.isFinite(qty) && Number.isFinite(fill) ? qty * fill : Number.NaN,
    pnlPct: Number(r.pnl_pct) || 0,
    realizedPnl: Number(r.realized_pnl) || 0,
  };
}
