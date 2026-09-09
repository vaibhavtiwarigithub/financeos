import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { buildDivergenceEvents, normalizeDivergenceObservations, SCORE_PRICE_DIVERGENCE_POLICY } from "@/lib/learning/score-price-divergence";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Market = "us" | "india";

function marketFrom(req: NextRequest): Market | null {
  const value = req.nextUrl.searchParams.get("market")?.toLowerCase();
  return value === "us" || value === "india" ? value : null;
}

function marketDate(market: Market, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function ownerOrCron(req: NextRequest) { return verifyCronSecret(req) ? null : requireOwner(); }

async function loadObservations(svc: any, market: Market) {
  const rows: any[] = [];
  const since = new Date(Date.now() - 240 * 86_400_000).toISOString();
  for (let from = 0; from < 30_000; from += 1000) {
    const { data, error } = await svc.from("decision_observations")
      .select("id,ts,market,symbol,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,price_at_decision,features,availability_mask,weights_used,score_source,scoring_version")
      .eq("market", market).gte("ts", since).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`decision observation read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function runShadow(market: Market) {
  const svc = createServiceClient();
  const raw = await loadObservations(svc, market);
  const normalized = normalizeDivergenceObservations(raw, market);
  const events = buildDivergenceEvents(normalized.points);
  const eventRows = events.map(event => ({ policy_version: SCORE_PRICE_DIVERGENCE_POLICY, market: event.market, symbol: event.symbol, window_sessions: event.windowSessions, start_observation_id: event.startObservationId, end_observation_id: event.endObservationId, start_session: event.startSession, end_session: event.endSession, direction: event.direction, score_delta: event.scoreDelta, price_return_pct: event.priceReturnPct, dimension_deltas: event.dimensionDeltas, score_source: event.scoreSource, scoring_version: event.scoringVersion, availability_fingerprint: event.availabilityFingerprint, weights_fingerprint: event.weightsFingerprint, is_primary: event.isPrimary }));
  for (let i = 0; i < eventRows.length; i += 500) {
    const { error } = await svc.from("score_price_divergence_events").upsert(eventRows.slice(i, i + 500), { onConflict: "policy_version,market,symbol,window_sessions,start_observation_id,end_observation_id", ignoreDuplicates: true });
    if (error) throw new Error(`divergence event insert failed: ${error.message}`);
  }

  const { data: storedEvents, error: eventError } = await svc.from("score_price_divergence_events")
    .select("id,end_observation_id").eq("market", market).eq("policy_version", SCORE_PRICE_DIVERGENCE_POLICY).limit(10_000);
  if (eventError) throw new Error(`stored divergence event read failed: ${eventError.message}`);
  const eventByObservation = new Map<number, string[]>();
  for (const event of storedEvents ?? []) {
    const id = Number(event.end_observation_id);
    const values = eventByObservation.get(id) ?? [];
    values.push(event.id); eventByObservation.set(id, values);
  }
  const observationIds = [...eventByObservation.keys()];
  let outcomesConsidered = 0;
  for (let i = 0; i < observationIds.length; i += 400) {
    const { data: labels, error } = await svc.from("observation_labels")
      .select("observation_id,horizon_days,fwd_return,benchmark_return,benchmark_neutral_return,max_adverse_excursion,max_favorable_excursion,matured_at")
      .in("observation_id", observationIds.slice(i, i + 400)).in("horizon_days", [5, 10, 20]);
    if (error) throw new Error(`divergence outcome read failed: ${error.message}`);
    const outcomeRows = (labels ?? []).flatMap((label: any) => (eventByObservation.get(Number(label.observation_id)) ?? []).map(eventId => ({ event_id: eventId, horizon_days: label.horizon_days, end_observation_id: label.observation_id, fwd_return: label.fwd_return, benchmark_return: label.benchmark_return, benchmark_neutral_return: label.benchmark_neutral_return, max_adverse_excursion: label.max_adverse_excursion, max_favorable_excursion: label.max_favorable_excursion, matured_at: label.matured_at })));
    if (outcomeRows.length) {
      const write = await svc.from("score_price_divergence_outcomes").upsert(outcomeRows, { onConflict: "event_id,horizon_days", ignoreDuplicates: true });
      if (write.error) throw new Error(`divergence outcome insert failed: ${write.error.message}`);
      outcomesConsidered += outcomeRows.length;
    }
  }

  const run = { market, run_session: marketDate(market), policy_version: SCORE_PRICE_DIVERGENCE_POLICY, input_observations: raw.length, canonical_sessions: normalized.points.length, events_detected: events.length, primary_events_detected: events.filter(event => event.isPrimary).length, exclusions: normalized.exclusions };
  const runWrite = await svc.from("score_price_divergence_runs").upsert(run, { onConflict: "market,run_session,policy_version", ignoreDuplicates: true });
  if (runWrite.error) throw new Error(`divergence run heartbeat failed: ${runWrite.error.message}`);
  return { ...run, outcomes_considered: outcomesConsidered, influence: "none" };
}

export async function POST(req: NextRequest) {
  const gate = await ownerOrCron(req); if (gate) return gate;
  const market = marketFrom(req); if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  try { return NextResponse.json(await runShadow(market)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "score-price divergence failed" }, { status: 500 }); }
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = marketFrom(req); if (!market) return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const svc = createServiceClient();
  const [runs, events] = await Promise.all([
    svc.from("score_price_divergence_runs").select("*").eq("market", market).order("created_at", { ascending: false }).limit(30),
    svc.from("score_price_divergence_events").select("*,score_price_divergence_outcomes(*)").eq("market", market).order("end_session", { ascending: false }).limit(250),
  ]);
  if (runs.error || events.error) return NextResponse.json({ error: runs.error?.message ?? events.error?.message }, { status: 500 });
  return NextResponse.json({ market, policy_version: SCORE_PRICE_DIVERGENCE_POLICY, runs: runs.data ?? [], events: events.data ?? [], influence: "none" });
}
