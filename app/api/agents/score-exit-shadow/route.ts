// Holding score-exit policy shadow — MEASURE ONLY.
// No scorer, position monitor, order or broker path reads this ledger.
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { isHoldingReview } from "@/lib/learning/entry-cohort";
import { evaluateScoreExitShadow, SCORE_EXIT_POLICY_VERSION, type ScoreExitShadowPoint } from "@/lib/learning/score-exit-shadow";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { createServiceClient } from "@/lib/supabase/service";
import { loadTradingMandateStrict, type TradingMarket } from "@/lib/trading-mandate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const HORIZONS = [2, 5, 10, 20];

async function authorize(req: NextRequest) {
  return verifyCronSecret(req) ? null : requireOwner();
}

async function run(req: NextRequest, persist: boolean) {
  const gate = await authorize(req);
  if (gate) return gate;
  const market = new URL(req.url).searchParams.get("market") as TradingMarket | null;
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const svc = createServiceClient();
  const rows = await fetchAllRows<any>((from, to) => svc.from("observation_labels")
    .select("id,horizon_days,fwd_return,benchmark_neutral_return,max_adverse_excursion,max_favorable_excursion,decision_observations!inner(id,ts,symbol,market,analyst_score,score_threshold,signal_id,entry_eligible,direction,decision_context,discovery_source)")
    .eq("decision_observations.market", market)
    .in("horizon_days", HORIZONS)
    .order("id", { ascending: true }).range(from, to), "score exit shadow labels");

  const signalIds = [...new Set(rows.map((row) => {
    const d = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    return d?.signal_id as string | null;
  }).filter(Boolean))] as string[];
  const validSignals = new Set<string>();
  for (let i = 0; i < signalIds.length; i += 200) {
    const { data, error } = await svc.from("agent_signals").select("id").in("id", signalIds.slice(i, i + 200))
      .eq("score_source", "deterministic_v1").eq("session_validated", true).eq("is_holding", true);
    if (error) return NextResponse.json({ error: `signal provenance read failed: ${error.message}` }, { status: 500 });
    for (const row of data ?? []) validSignals.add(String(row.id));
  }

  const points = new Map<number, ScoreExitShadowPoint[]>();
  for (const row of rows) {
    const d = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    if (!d || !validSignals.has(String(d.signal_id ?? ""))) continue;
    if (!isHoldingReview({ decisionContext: d.decision_context, discoverySource: d.discovery_source })) continue;
    const score = Number(d.analyst_score), threshold = Number(d.score_threshold), fwd = Number(row.fwd_return);
    if (![score, threshold, fwd].every(Number.isFinite)) continue;
    const horizon = Number(row.horizon_days);
    const bucket = points.get(horizon) ?? [];
    bucket.push({
      date: String(d.ts).slice(0, 10), symbol: String(d.symbol), score, entryThreshold: threshold,
      forwardReturn: fwd,
      benchmarkNeutralReturn: row.benchmark_neutral_return == null ? null : Number(row.benchmark_neutral_return),
      mae: row.max_adverse_excursion == null ? null : Number(row.max_adverse_excursion),
      mfe: row.max_favorable_excursion == null ? null : Number(row.max_favorable_excursion),
    });
    points.set(horizon, bucket);
  }

  const mandate = await loadTradingMandateStrict(svc, market);
  const results = HORIZONS.map((horizonDays) => evaluateScoreExitShadow({
    market, horizonDays, points: points.get(horizonDays) ?? [], stopPct: mandate.stop_loss_pct, targetPct: mandate.target_pct,
  }));
  const asOfDate = new Date().toISOString().slice(0, 10);
  if (persist) {
    for (const result of results) {
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ market, horizon: result.horizonDays, points: points.get(result.horizonDays) ?? [] })).digest("hex");
      const { error } = await svc.from("score_exit_shadow_runs").insert({
        as_of_date: asOfDate, market, horizon_days: result.horizonDays, policy_version: SCORE_EXIT_POLICY_VERSION,
        input_fingerprint: fingerprint, observation_count: result.observationCount,
        distinct_session_count: result.distinctSessions, effective_observations: result.effectiveObservations,
        status: result.status, results: result,
      });
      // Immutable/idempotent: an already-recorded daily run is success, never an update.
      if (error && error.code !== "23505") return NextResponse.json({ error: `write failed: ${error.message}` }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, persisted: persist, asOfDate, market, results, influence: "Measure-only. No trading path reads score_exit_shadow_runs." });
}

export async function GET(req: NextRequest) { return run(req, false); }
export async function POST(req: NextRequest) { return run(req, true); }
