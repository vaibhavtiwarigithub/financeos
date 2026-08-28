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
    tests: ["A0", "A1", "A3", "A4", "A5", "A7"],
    minReviewDates: MIN_REVIEW_DATES,
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
      trials_considered: plan.tests.length,
      started_at: startedAt,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    return NextResponse.json({ error: `plan insert failed: ${planErr?.message ?? "no row"}` }, { status: 500 });
  }
  const runId = (planRow as any).id;

  try {
    // ── Load persisted ledgers only. No provider call anywhere below. ────────
    const [perfRes, tradesRes] = await Promise.all([
      svc.from("paper_performance")
        .select("date, nav, cash_balance, positions_value, bench_nav, bench_session_date, bench_source, tainted")
        .eq("market", market).order("date", { ascending: true }),
      svc.from("paper_trades")
        .select("symbol, market, realized_pnl, pnl_pct, exit_reason, fill_price, qty, tainted, excluded_from_learning, closed_at")
        .eq("market", market).not("closed_at", "is", null),
    ]);
    if (perfRes.error) throw new Error(`paper_performance read failed: ${perfRes.error.message}`);
    if (tradesRes.error) throw new Error(`paper_trades read failed: ${tradesRes.error.message}`);

    const perfRows = (perfRes.data ?? []) as any[];
    const tradeRows = (tradesRes.data ?? []) as any[];

    const navRows: NavRow[] = perfRows.map(r => ({
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
      findings.push(runA3Payoff(market, learningLots));
      findings.push(runA4ExitPaths(market, learningLots.map(toExitPathLot)));
      findings.push(runA5Sizing(market, tradeRows
        .filter(r => r.tainted !== true && r.excluded_from_learning !== true)
        .map(toSizedLot)
        .filter(l => Number.isFinite(l.entryNotional))));
      findings.push(runA7CostStress(market, learningLots));
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
      coverage: { navRows: navRows.length },
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
