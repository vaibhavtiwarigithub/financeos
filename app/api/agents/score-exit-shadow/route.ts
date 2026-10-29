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
import { producerOutcomeFromResponse, runWithProducerHealth } from "@/lib/shadows/producer-runs";
import { CURRENT_LABEL_CONTRACT_VERSION } from "@/lib/learning/label-contract";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const HORIZONS = [2, 5, 10, 20];

async function authorize(req: NextRequest) {
  return verifyCronSecret(req) ? null : requireOwner();
}

async function runAuthorized(req: NextRequest, persist: boolean) {
  const market = new URL(req.url).searchParams.get("market") as TradingMarket | null;
  if (market !== "us" && market !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const svc = createServiceClient();
  const decisionFields = "id,ts,symbol,market,analyst_score,score_threshold,signal_id,entry_eligible,direction,decision_context,discovery_source,technical_as_of:features->technical->>as_of";
  const decisionsById = new Map<string, any>();
  const decisionQueries = [
    (from: number, to: number) => svc.from("decision_observations").select(decisionFields)
      .eq("market", market).eq("decision_context", "holding_review")
      .order("id", { ascending: true }).range(from, to),
    // Preserve the documented legacy holding cohort while avoiding a scan of
    // every market decision and every associated forward label.
    (from: number, to: number) => svc.from("decision_observations").select(decisionFields)
      .eq("market", market).in("discovery_source", ["holding", "india_holding"])
      .order("id", { ascending: true }).range(from, to),
  ];
  for (const [index, query] of decisionQueries.entries()) {
    const rows = await fetchAllRows<any>(query, `score exit ${market} holding decisions ${index + 1}`, {
      retries: 1, retryIf: (message) => message.includes("Gateway Timeout"),
    });
    for (const row of rows) if (isHoldingReview({ decisionContext: row.decision_context, discoverySource: row.discovery_source })) {
      decisionsById.set(String(row.id), row);
    }
  }
  const decisions = [...decisionsById.values()];

  const signalIds = [...new Set(decisions.map((row) => row.signal_id as string | null).filter(Boolean))] as string[];
  const validSignals = new Set<string>();
  for (let i = 0; i < signalIds.length; i += 200) {
    const { data, error } = await svc.from("agent_signals").select("id").in("id", signalIds.slice(i, i + 200))
      .eq("market", market).eq("score_source", "deterministic_v1").eq("session_validated", true).eq("is_holding", true);
    if (error) return NextResponse.json({ error: `signal provenance read failed: ${error.message}` }, { status: 500 });
    for (const row of data ?? []) validSignals.add(String(row.id));
  }

  const validDecisions = decisions.filter((row) => row.signal_id && validSignals.has(String(row.signal_id)));
  const decisionsByObservationId = new Map(validDecisions.map((row) => [String(row.id), row]));
  const observationIds = [...decisionsByObservationId.keys()];
  const rows: any[] = [];
  for (let i = 0; i < observationIds.length; i += 200) {
    const ids = observationIds.slice(i, i + 200);
    const labels = await fetchAllRows<any>((from, to) => svc.from("observation_labels")
      .select("id,observation_id,horizon_days,fwd_return,benchmark_neutral_return,max_adverse_excursion,max_favorable_excursion")
      .eq("label_contract_version", CURRENT_LABEL_CONTRACT_VERSION)
      .in("observation_id", ids).in("horizon_days", HORIZONS)
      .not("fwd_return", "is", null).lte("matured_at", new Date().toISOString())
      .order("id", { ascending: true }).range(from, to), `score exit ${market} matured holding labels`);
    rows.push(...labels.map((label) => ({ ...label, decision_observations: decisionsByObservationId.get(String(label.observation_id)) })));
  }

  const points = new Map<number, ScoreExitShadowPoint[]>();
  for (const row of rows) {
    const d = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    if (!d) continue;
    if (!isHoldingReview({ decisionContext: d.decision_context, discoverySource: d.discovery_source })) continue;
    if (d.analyst_score == null || d.score_threshold == null || row.fwd_return == null) continue;
    const score = Number(d.analyst_score), threshold = Number(d.score_threshold), fwd = Number(row.fwd_return);
    if (![score, threshold, fwd].every(Number.isFinite)) continue;
    const horizon = Number(row.horizon_days);
    const bucket = points.get(horizon) ?? [];
    bucket.push({
      date: typeof d.technical_as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.technical_as_of) ? d.technical_as_of : String(d.ts).slice(0, 10), symbol: String(d.symbol), score, entryThreshold: threshold,
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
  const observedSession = rows.map((row) => {
    const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    return typeof decision?.ts === "string" ? decision.ts.slice(0, 10) : "";
  }).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().at(-1) ?? null;
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
  return NextResponse.json({ ok: true, persisted: persist, asOfDate, observedSession, market, results, influence: "Measure-only. No trading path reads score_exit_shadow_runs." });
}

async function run(req: NextRequest, persist: boolean) {
  const gate = await authorize(req);
  if (gate) return gate;
  const market = new URL(req.url).searchParams.get("market");
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }
  if (!persist) return runAuthorized(req, false);

  const svc = createServiceClient();
  return runWithProducerHealth({
    client: svc,
    programId: "score-exit-shadow",
    market,
    triggerSource: verifyCronSecret(req) ? "cron_authenticated" : "owner_manual",
    codeVersion: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    work: async () => {
      const response = await runAuthorized(req, true);
      return {
        value: response,
        outcome: await producerOutcomeFromResponse(response, "holding_score_decision_label_metrics"),
      };
    },
  });
}

export async function GET(req: NextRequest) { return run(req, false); }
export async function POST(req: NextRequest) { return run(req, true); }
