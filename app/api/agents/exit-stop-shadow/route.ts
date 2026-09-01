// ATR exit-stop shadow — MEASURE-ONLY.
//
// GET  = dry run, returns the comparison and writes nothing.
// POST = persists one row per (as_of_date, market, horizon) to
//        `exit_stop_shadow_runs`. Owner or cron only.
//
// Changes no stop, target, time stop, order, position or exit. Nothing in the
// money path reads `exit_stop_shadow_runs`.
// See features/atr-exit-stop/FEATURE_ARCHITECTURE.md.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { isEligibleLong } from "@/lib/learning/entry-cohort";
import { runStopShadow, type StopShadowPoint } from "@/lib/trading/exit-stop-shadow";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_HORIZON_DAYS = 10;
const ALLOWED_HORIZONS = [2, 5, 10, 20];

async function authorize(req: NextRequest): Promise<NextResponse | null> {
  if (verifyCronSecret(req)) return null;
  return requireOwner();
}

function horizonFrom(req: NextRequest): number {
  const requested = Number(new URL(req.url).searchParams.get("horizon"));
  return ALLOWED_HORIZONS.includes(requested) ? requested : DEFAULT_HORIZON_DAYS;
}

async function loadPoints(svc: any, horizonDays: number, marketFilter: string | null) {
  // Paginated: `.limit()` above the PostgREST server maximum is silently capped,
  // which truncated several readers on this codebase before the sweep.
  const rows = await fetchAllRows((from, to) => svc
    .from("observation_labels")
    .select("horizon_days,max_favorable_excursion,max_adverse_excursion,fwd_return,entry_atr_pct,decision_observations!inner(ts,symbol,market,entry_eligible,direction)")
    .eq("horizon_days", horizonDays)
    .order("id", { ascending: true })
    .range(from, to), "exit stop shadow labels");

  const byMarket = new Map<string, StopShadowPoint[]>();
  for (const row of rows as any[]) {
    const d = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    if (!d) continue;
    // The cohort that could actually become a position. An exit rule cannot be
    // informed by decisions that never passed the entry gate.
    if (!isEligibleLong(d.entry_eligible, d.direction)) continue;
    if (marketFilter && d.market !== marketFilter) continue;
    if (row.max_favorable_excursion == null || row.max_adverse_excursion == null) continue;

    const atr = Number(row.entry_atr_pct);
    const bucket = byMarket.get(d.market) ?? [];
    bucket.push({
      date: String(d.ts).slice(0, 10),
      symbol: String(d.symbol ?? ""),
      mfe: Number(row.max_favorable_excursion),
      mae: Number(row.max_adverse_excursion),
      fwd: Number(row.fwd_return),
      // Absent ATR is kept and becomes an unresolvable candidate arm, which
      // drops the PAIR. Visible in pairsDropped rather than silently excluded.
      atrPct: Number.isFinite(atr) && atr > 0 ? atr : 0,
    });
    byMarket.set(d.market, bucket);
  }
  return byMarket;
}

async function run(req: NextRequest, persist: boolean) {
  const gate = await authorize(req);
  if (gate) return gate;

  const horizonDays = horizonFrom(req);
  const marketParam = new URL(req.url).searchParams.get("market");
  const marketFilter = marketParam === "us" || marketParam === "india" ? marketParam : null;
  const svc = createServiceClient();

  let byMarket: Map<string, StopShadowPoint[]>;
  try {
    byMarket = await loadPoints(svc, horizonDays, marketFilter);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "label read failed" }, { status: 500 });
  }

  const asOfDate = new Date().toISOString().slice(0, 10);
  const codeVersion = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const results = [...byMarket.entries()]
    .map(([market, points]) => runStopShadow(market, horizonDays, points))
    // US and India are never pooled: different benchmarks, sessions, currency.
    .sort((a, b) => a.market.localeCompare(b.market));

  if (persist) {
    for (const r of results) {
      const { error } = await svc.from("exit_stop_shadow_runs").upsert({
        as_of_date: asOfDate, market: r.market, horizon_days: r.horizonDays,
        n_rows: r.nRows, n_dates: r.nDates, n_symbols: r.nSymbols,
        effective_observations: r.effectiveObservations, atr_coverage: r.atrCoverage,
        baseline_stops: r.baselineStops, candidate_stops: r.candidateStops,
        baseline_timeouts: r.baselineTimeouts, candidate_timeouts: r.candidateTimeouts,
        baseline_targets: r.baselineTargets, candidate_targets: r.candidateTargets,
        pairs_dropped: r.pairsDropped, ambiguous_share: r.ambiguousShare,
        baseline_mean_return: r.baselineMeanReturn, candidate_mean_return: r.candidateMeanReturn,
        mean_paired_diff: r.meanPairedDiff, paired_diff_t: r.pairedDiffT,
        candidate_worst_return: r.candidateWorstReturn, baseline_worst_return: r.baselineWorstReturn,
        trials_considered: r.trialsConsidered, sidak_alpha: r.sidakAlpha,
        status: r.status, reason: r.reason, code_version: codeVersion,
      }, { onConflict: "as_of_date,market,horizon_days" });
      if (error) return NextResponse.json({ error: `write failed: ${error.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true, asOfDate, horizonDays, persisted: persist, results,
    hypothesis: "H1: a 2.8 ATR stop reduces premature stop-outs and raises mean return, with target and time stop unchanged.",
    influence: "None. Measure-only; no scoring, sizing, stop, target, exit, order or broker path reads this.",
  });
}

export async function GET(req: NextRequest) { return run(req, false); }
export async function POST(req: NextRequest) { return run(req, true); }
