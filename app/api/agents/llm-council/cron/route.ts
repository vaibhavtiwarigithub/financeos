import { NextRequest, NextResponse } from "next/server";
import { callLLM, isReasoningModel, priceFor } from "@/lib/llm-router";
import { providerForModel, getProviderKey } from "@/lib/llm-keys";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { councilProviderTimeoutMs, createCouncilBudgetGuard, effectiveCouncilDebateRounds, limitCouncilCandidates, validCouncilConsensus, validCouncilParticipants } from "@/lib/llm-council/limits";
import { isCouncilModel } from "@/lib/llm-model-catalog";
import { extractJson, medianScore, parseForecast, sha256, validateForecastCitations, type Forecast } from "@/lib/llm-council/core";
import { COUNCIL_ALL_RESEARCH_COHORT_KEY, COUNCIL_COHORT_HALF_WIDTH, isNearThresholdEntryLong } from "@/lib/llm-council/cohort";
import { selectCouncilCandidates } from "@/lib/llm-council/selection";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { enqueueSubscription, sweepSubscriptionBatches } from "@/lib/llm-council/subscription";
import { COUNCIL_FORMULA_VERSIONS } from "@/lib/scoring/formula-lineage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REPAIRABLE = /^Error: (model_output_not_json|model_citation_|model_citations_required|model_score_|model_confidence_)/;
function citationGuidance(snapshot: Record<string, unknown>): string {
  const roots = Object.keys(snapshot);
  const features = snapshot.features && typeof snapshot.features === "object" ? Object.keys(snapshot.features as object).slice(0, 40) : [];
  return ` Every evidence_citations[].source must be EXACTLY ONE dotted path that exists in the frozen JSON (never several paths joined by commas, never a key that is not there). Valid top-level keys: ${roots.join(", ")}.${features.length ? ` Keys directly under "features": ${features.join(", ")}.` : ""} Use as_of "unknown" unless that cited object carries its own timestamp.`;
}
const MAX_TURN_TOKENS = 900; // prompts demand a ~450-token answer; the cap is a backstop, not the target
const MAX_TURN_CHARS = 45_000;
const MAX_OBSERVATION_SCAN = 5_000;
const SYSTEM = "You are a research analyst in a shadow-only stock research experiment. Use only the supplied frozen evidence. Do not use or invent current facts from model memory. If a field has no source/as-of timestamp, say its date is unknown. Cite factual claims using evidence paths from the snapshot and their recorded as-of date. Output exactly one RFC 8259 JSON object using straight ASCII double quotes; no smart quotes, markdown fences, comments, trailing commas, or surrounding prose. Escape quotes inside strings. This opinion never places or changes trades.";

function estimateCost(model: string, prompt: string, maxOutput = MAX_TURN_TOKENS): number {
  const [inputRate, outputRate] = priceFor(model);
  // Deliberately pessimistic input estimate: one token per character, not the
  // usual ~3-4 characters/token. This is a reservation guard, not billing.
  const effectiveOutputBudget = isReasoningModel(model) ? Math.max(maxOutput, 16_000) : maxOutput;
  return (prompt.length / 1_000_000 * inputRate) + (effectiveOutputBudget / 1_000_000 * outputRate);
}

function estimateWorstCaseTurnCost(model: string, prompt: string, parsed: boolean): number {
  const firstAttempt = estimateCost(model, SYSTEM + prompt);
  if (!parsed) return firstAttempt;
  // invokeWithRepair may make one more paid call after a validation failure.
  // Reserve its fixed feedback overhead and short-output ceiling up front.
  return firstAttempt + estimateCost(model, `${SYSTEM}${prompt}${" ".repeat(500)}`, 250);
}

function asSnapshot(row: any) {
  return {
    council_formula_versions: COUNCIL_FORMULA_VERSIONS,
    source_formula_lineage: row.features?.formula_lineage ?? null,
    symbol: row.symbol,
    market: row.market,
    observed_at: row.ts,
    price_at_decision: row.price_at_decision,
    currency: row.currency,
    deterministic_score: {
      composite: row.analyst_score,
      fundamental: row.fundamental_score,
      technical: row.technical_score,
      sentiment: row.sentiment_score,
      macro: row.macro_score,
      insider: row.insider_score,
      direction: row.direction,
      threshold: row.score_threshold,
      availability_mask: row.availability_mask,
    },
    features: row.features,
    provenance: {
      code_version: row.code_version,
      decision_context: row.decision_context,
      discovery_source: row.discovery_source,
      note: "The observation timestamp is the freeze boundary. Any feature without its own provider/as-of metadata has unknown source age; models must disclose that limitation.",
    },
  };
}

async function addPointInTimeRelationships(svc: any, row: any, base: Record<string, unknown>) {
  const date = String(row.ts).slice(0, 10);
  const asOf = String(row.ts);
  const { data: profiles, error: profileError } = await svc.from("symbol_profiles")
    .select("sector,industry,company_name,one_liner,peers,source,updated_at")
    .eq("symbol", row.symbol).eq("market", row.market).lte("updated_at", asOf)
    .order("updated_at", { ascending: false }).limit(1);
  const profile = profileError ? null : profiles?.[0] ?? null;
  const peers: string[] = Array.isArray(profile?.peers)
    ? [...new Set<string>(profile.peers.filter((x: unknown): x is string => typeof x === "string" && !!x.trim()).map((x: string) => x.trim().toUpperCase()))].filter((x) => x !== row.symbol).slice(0, 6)
    : [];

  const [peerBars, peerResearch, earnings] = await Promise.all([
    // price_cache has a date but no intraday availability timestamp. A bar
    // stamped with the decision date may have been written after this score,
    // so only completed prior sessions are valid point-in-time peer evidence.
    peers.length ? svc.from("price_cache").select("symbol,date,open,close").in("symbol", peers).lt("date", date).order("date", { ascending: false }).limit(120) : Promise.resolve({ data: [], error: null }),
    peers.length ? svc.from("decision_observations").select("symbol,ts,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,direction,entry_eligible,decision_context,discovery_source").eq("market", row.market).eq("entry_eligible", true).gte("ts", `${date}T00:00:00.000Z`).lte("ts", asOf).order("ts", { ascending: false }).limit(300) : Promise.resolve({ data: [], error: null }),
    svc.from("earnings_consensus_snapshots").select("symbol,report_date,fiscal_period,consensus_eps,analyst_count,basis,currency,source,available_at,snapshot_at")
      .in("symbol", [row.symbol, ...peers]).eq("market", row.market).lte("available_at", asOf).lte("snapshot_at", asOf)
      .gte("report_date", date).order("snapshot_at", { ascending: false }).limit(100),
  ]);

  const peerMarks = new Map<string, Array<{ date: string; open: number | null; close: number | null }>>();
  if (!peerBars.error) for (const mark of peerBars.data ?? []) {
    const list = peerMarks.get(mark.symbol) ?? [];
    if (list.length < 2) list.push({ date: String(mark.date), open: mark.open == null ? null : Number(mark.open), close: mark.close == null ? null : Number(mark.close) });
    peerMarks.set(mark.symbol, list);
  }
  const peerPriceContext = peers.map((symbol) => {
    const marks = peerMarks.get(symbol) ?? [];
    const latest = marks[0];
    const prior = marks[1];
    const sessionPct = latest?.open != null && latest.open > 0 && latest.close != null ? ((latest.close / latest.open) - 1) * 100 : null;
    const priorClosePct = latest?.close != null && prior?.close != null && prior.close > 0 ? ((latest.close / prior.close) - 1) * 100 : null;
    return { symbol, latest_as_of_date: latest?.date ?? null, close: latest?.close ?? null, session_change_pct: sessionPct, prior_close_change_pct: priorClosePct };
  });

  const peerScoreBySymbol = new Map<string, any>();
  if (!peerResearch.error) for (const observation of peerResearch.data ?? []) {
    if (!peers.includes(observation.symbol) || peerScoreBySymbol.has(observation.symbol)) continue;
    peerScoreBySymbol.set(observation.symbol, {
      observed_at: observation.ts,
      composite: observation.analyst_score,
      fundamental: observation.fundamental_score,
      technical: observation.technical_score,
      sentiment: observation.sentiment_score,
      macro: observation.macro_score,
      insider: observation.insider_score,
      direction: observation.direction,
      eligible_long: observation.entry_eligible && observation.direction === "long",
      discovery_source: observation.discovery_source,
    });
  }
  const earningsBySymbol = new Map<string, any[]>();
  if (!earnings.error) for (const vintage of earnings.data ?? []) {
    if (vintage.report_date && String(vintage.report_date) < date) continue;
    const list = earningsBySymbol.get(vintage.symbol) ?? [];
    // Keep at most the latest known vintage per symbol/report date.
    const keyExists = list.some((x) => x.report_date === vintage.report_date);
    if (!keyExists) list.push(vintage);
    earningsBySymbol.set(vintage.symbol, list);
  }
  return {
    ...base,
    point_in_time_relationships: {
      profile: profile ? { company_name: profile.company_name, one_liner: profile.one_liner, sector: profile.sector, industry: profile.industry, peers, source: profile.source, as_of: profile.updated_at } : { status: profileError ? "unavailable" : "not recorded" },
      peer_prices: peerBars.error ? { status: "unavailable" } : peerPriceContext,
      peer_research_scores: peerResearch.error ? { status: "unavailable" } : Object.fromEntries(peerScoreBySymbol),
    },
    forward_earnings_consensus: earnings.error ? { status: "unavailable" } : {
      interpretation: "Analyst consensus vintage only; this is not company-issued forward guidance.",
      vintages_by_symbol: Object.fromEntries(earningsBySymbol),
      as_of_cutoff: asOf,
    },
  };
}

async function invoke(
  svc: any,
  args: { runId: string; symbol: string; requestedModel: string; role: "independent" | "debate" | "orchestrator"; round: number; prompt: string; timeoutMs: number; parse?: boolean; snapshot?: unknown; attempt?: 0 | 1 },
) {
  const provider = providerForModel(args.requestedModel);
  const persist = async (row: Record<string, unknown>) => {
    const { error } = await svc.from("llm_council_turns").insert({
      run_id: args.runId, model_requested: args.requestedModel, model_used: null,
      turn_role: args.role, round: args.round, attempt: args.attempt ?? 0, prompt_sha256: sha256(args.prompt),
      output_json: null, output_text: null, tokens_in: 0, tokens_out: 0, cost_usd: 0,
      ...row,
    });
    if (error) throw new Error(`turn_persist_failed:${error.message}`);
  };
  let result;
  try {
    if (args.prompt.length > MAX_TURN_CHARS) throw new Error("prompt_too_large");
    if (!provider || !(await getProviderKey(provider, svc))) throw new Error(`provider_key_missing:${provider ?? "unknown"}`);
    result = await callLLM({
      task: "evaluate", model: args.requestedModel, prompt: args.prompt, systemPrompt: SYSTEM,
      maxTokens: MAX_TURN_TOKENS, timeoutMs: args.timeoutMs, symbol: args.symbol, agentLabel: "llm-council", runId: args.runId,
    });
  } catch (error) {
    await persist({ status: "failed", output_text: String(error).slice(0, 500) });
    throw error;
  }
  let parsed: unknown = null;
  if (args.parse) {
    try {
      parsed = extractJson(result.text);
      if (args.snapshot !== undefined) parsed = validateForecastCitations(parseForecast(JSON.stringify(parsed)), args.snapshot);
    }
    catch (error) {
      await persist({ model_used: result.model, output_text: result.text.slice(0, 12000), tokens_in: result.tokensIn, tokens_out: result.tokensOut, cost_usd: result.costUsd, status: "invalid_output" });
      throw error;
    }
  }
  const status = result.model !== args.requestedModel ? "fallback_mismatch" : "completed";
  await persist({ model_used: result.model, output_json: parsed, output_text: result.text.slice(0, 12000), tokens_in: result.tokensIn, tokens_out: result.tokensOut, cost_usd: result.costUsd, status });
  if (status !== "completed") throw new Error(`model_fallback_mismatch:${args.requestedModel}->${result.model}`);
  return { result, parsed };
}

/**
 * One bounded repair retry when the model's reply fails validation (bad JSON, bad citation path, out-of-range
 * numbers). The validator's error is shown to the model; fabricated citations are still rejected. Skipped when
 * the invocation has already used most of its runtime so a slow five-member run cannot overrun maxDuration.
 */
async function invokeWithRepair(svc: any, args: Parameters<typeof invoke>[1], startedAt: number) {
  try { return await invoke(svc, args); }
  catch (error) {
    if (!args.parse || !REPAIRABLE.test(String(error)) || Date.now() - startedAt > 150_000) throw error;
    const citationNote = args.snapshot !== undefined ? ` Each evidence_citations[].source must be exactly one existing dotted path from the frozen evidence (no commas, no invented keys); use as_of "unknown" unless that object carries its own timestamp.` : "";
    const feedback = `

Your previous reply was rejected by the validator with "${String(error).replace(/^Error: /, "")}". Reply again with ONE corrected, SHORTER JSON object only, well under 250 tokens.${citationNote}`;
    return await invoke(svc, { ...args, prompt: args.prompt + feedback, attempt: 1 });
  }
}

async function invokeWithinBudget(
  svc: any,
  args: Parameters<typeof invoke>[1],
  startedAt: number,
  budget: ReturnType<typeof createCouncilBudgetGuard>,
  refreshActualSpend: () => Promise<number>,
) {
  const reservation = budget.reserve(estimateWorstCaseTurnCost(args.requestedModel, args.prompt, !!args.parse));
  if (!reservation) throw new Error("daily_budget_exhausted_before_call");
  try {
    return await invokeWithRepair(svc, args, startedAt);
  } finally {
    // Keep the pessimistic reserve if usage cannot be reconciled. Failing
    // closed here prevents a ledger outage from reopening the budget gate.
    const actual = await refreshActualSpend();
    budget.syncRunSpend(args.runId, actual);
    budget.release(reservation);
  }
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const requestedMarket = new URL(req.url).searchParams.get("market");
  if (requestedMarket !== "us" && requestedMarket !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const invocationStartedAt = Date.now();
  const svc = createServiceClient();
  const { data: config, error: configError } = await svc.from("llm_council_config").select("*").eq("id", "global").single();
  if (configError || !config) return NextResponse.json({ error: "LLM council migration is not installed" }, { status: 503 });
  try { await sweepSubscriptionBatches(svc); } catch { return NextResponse.json({ error: "Subscription queue could not be checked" }, { status: 503 }); }
  if (!config.enabled) return NextResponse.json({ skipped: "disabled" });
  const subscription = config.execution_mode === "subscription";
  const hybrid = config.execution_mode === "hybrid";

  const now = new Date();
  // Provider/process timeouts can leave a unique observation stuck as running.
  // Finalize abandoned runs once so they remain visible instead of silently
  // blocking retries forever.
  const staleBefore = new Date(now.getTime() - 30 * 60_000).toISOString();
  const { data: staleRuns, error: staleReadError } = await svc.from("llm_council_runs")
    .select("id,config_snapshot").eq("status", "running").lt("created_at", staleBefore).limit(100);
  if (staleReadError) return NextResponse.json({ error: "Could not inspect incomplete council runs" }, { status: 500 });
  for (const stale of staleRuns ?? []) {
    if (["subscription", "hybrid"].includes(stale.config_snapshot?.execution_mode)) continue;
    await svc.from("llm_council_runs").update({
      status: "failed", failure_code: "stale_incomplete_run", completed_at: now.toISOString(),
    }).eq("id", stale.id).eq("status", "running");
  }
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const { data: dailyRuns, error: dailyError } = await svc.from("llm_council_runs").select("id,cost_usd,status,market").gte("created_at", dayStart);
  if (dailyError) return NextResponse.json({ error: "Could not read council budget ledger" }, { status: 500 });
  const { data: callLogs, error: callLogError } = await svc.from("llm_call_log").select("cost_usd").eq("agent_label", "llm-council").gte("created_at", dayStart);
  if (callLogError) return NextResponse.json({ error: "Could not read actual council LLM spend" }, { status: 500 });
  let dailySpend = (callLogs ?? []).reduce((sum: number, row: any) => sum + Number(row.cost_usd ?? 0), 0);
  const budgetGuard = createCouncilBudgetGuard(dailySpend, Number(config.daily_budget_usd));
  const dailyCount = (dailyRuns ?? []).filter((r: any) => r.market === requestedMarket && r.status !== "budget_skipped").length;
  const remainingSymbols = Math.max(0, Number(config.max_symbols_per_market_day) - dailyCount);
  if (remainingSymbols === 0) return NextResponse.json({ skipped: "daily_symbol_cap", dailySpend });
  const participants = (subscription ? config.subscription_worker_ids : config.participant_models) as string[];
  if (!subscription && !validCouncilParticipants(participants, isCouncilModel, providerForModel)) {
    return NextResponse.json({ error: "Council roster is invalid or includes a retired model; update Settings → LLM Council" }, { status: 409 });
  }
  if (hybrid && participants.length + (config.subscription_worker_ids as string[]).length > 5) return NextResponse.json({ error: "Hybrid roster exceeds five total council members" }, { status: 409 });
  const debateRounds = hybrid ? 0 : effectiveCouncilDebateRounds(participants.length, Number(config.debate_rounds));
  const providerTimeoutMs = councilProviderTimeoutMs(participants.length, debateRounds);

  // Fresh research only: the council shadows the decision slots, so an observation older than 12 h is not scored late.
  const observationCutoff = new Date(now.getTime() - 12 * 3_600_000).toISOString();
  const obsRows: any[] = [];
  for (let offset = 0; offset <= MAX_OBSERVATION_SCAN; offset += 500) {
    const pageSize = Math.min(500, MAX_OBSERVATION_SCAN + 1 - offset);
    const { data, error } = await svc.from("decision_observations")
      .select("id,ts,market,symbol,code_version,features,availability_mask,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,direction,entry_eligible,score_threshold,price_at_decision,currency,decision_context,discovery_source")
      .eq("market", requestedMarket).gte("ts", observationCutoff)
      .order("ts", { ascending: false }).order("id", { ascending: false }).range(offset, offset + pageSize - 1);
    if (error) return NextResponse.json({ error: "Could not load frozen research observations" }, { status: 500 });
    obsRows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    if (obsRows.length > MAX_OBSERVATION_SCAN) {
      return NextResponse.json({ error: "Recent research universe exceeds the council's safe candidate-scan limit; no partial cohort was selected" }, { status: 503 });
    }
  }
  let priorRuns: any[];
  try {
    priorRuns = await fetchAllRows((from, to) => svc.from("llm_council_runs").select("observation_id,symbol,decision_ts")
      .eq("market", requestedMarket).gte("decision_ts", observationCutoff).order("decision_ts", { ascending: true }).order("id", { ascending: true }).range(from, to), "council prior runs");
  } catch { return NextResponse.json({ error: "Could not read existing council runs" }, { status: 500 }); }
  // Every research symbol, once per market session (see selectCouncilCandidates for the exact rule).
  const rankedCandidates = selectCouncilCandidates({ observations: obsRows, priorRuns });
  const candidates = rankedCandidates.slice(0, remainingSymbols);

  const outcomes: Array<Record<string, unknown>> = [];
  let stopAll = false;
  const processObservation = async (observation: any): Promise<void> => {
    const snapshot = await addPointInTimeRelationships(svc, observation, asSnapshot(observation));
    const snapshotText = JSON.stringify(snapshot);
    if (subscription) {
      try {
        const batchId = await enqueueSubscription(svc, config, snapshot, Number(observation.id));
        outcomes.push({ symbol: observation.symbol, status: "queued_for_subscription_workers", batchId });
      } catch (error) { outcomes.push({ symbol: observation.symbol, status: "queue_refused", issue: String(error).slice(0, 180) }); }
      return;
    }
    const independentPrompt = `Frozen decision-time evidence JSON (all numbers must come from this object):\n${snapshotText}\n\nScore this symbol's relative attractiveness over the next 10 market sessions. Give a score from 0 (least attractive) to 100 (most attractive), NOT a price target or return percent. Be independent: do not assume the deterministic score is correct. Return exactly one valid JSON object matching this schema (the type labels below are descriptions, not literal output): {"score": number, "confidence": number from 0 to 1, "rationale": string, "bull_case": string, "bear_case": string, "evidence_citations": [{"claim": string, "source": "existing JSON path or field", "as_of": "timestamp/date or 'unknown'"}]}. Use straight ASCII double quotes only. No smart quotes, code fence, comments, trailing comma, or text before/after the object. Provide at least one citation. Cite only paths that exist in the supplied snapshot and give only the timestamp that belongs to that data field, or "unknown" when it has no source timestamp. Explicitly state missing/stale data and what could falsify your view. Be LEAN: rationale at most 300 characters, bull_case and bear_case at most 120 characters each, at most 3 evidence_citations with claims under 80 characters; the whole JSON object must fit in about 250 tokens or it will be cut off and discarded.${citationGuidance(snapshot as Record<string, unknown>)}`;
    if (!budgetGuard.canReserve(estimateWorstCaseTurnCost(participants[0], independentPrompt, true))) {
      outcomes.push({ symbol: observation.symbol, status: "skipped", issue: "daily_budget_cannot_reserve_first_forecast" });
      stopAll = true;
      return;
    }
    const configSnapshot = {
      execution_mode: hybrid ? "hybrid" : "api",
      participant_models: participants,
      subscription_worker_ids: hybrid ? config.subscription_worker_ids : [],
      orchestrator_model: config.orchestrator_model,
      debate_rounds: debateRounds,
      configured_debate_rounds: config.debate_rounds,
      max_symbols_per_market_day: config.max_symbols_per_market_day,
      daily_budget_usd: config.daily_budget_usd,
      cohort_key: COUNCIL_ALL_RESEARCH_COHORT_KEY,
      near_threshold_entry_long: isNearThresholdEntryLong(observation),
      cohort_half_width_points: COUNCIL_COHORT_HALF_WIDTH,
    };
    const { data: run, error: createError } = await svc.from("llm_council_runs").insert({
      observation_id: observation.id, market: requestedMarket, symbol: observation.symbol, decision_ts: observation.ts,
      status: "running", input_snapshot: snapshot, input_sha256: sha256(snapshotText), config_snapshot: configSnapshot,
      prompt_version: config.prompt_version,
    }).select("id").single();
    if (createError || !run) {
      outcomes.push({ symbol: observation.symbol, status: "already_started_or_persist_failed" });
      return;
    }

    let tokensIn = 0, tokensOut = 0, costUsd = 0;
    const forecasts = new Map<string, { initial: Forecast; final: Forecast; modelUsed: string }>();
    let budgetExhausted = false;
    const canCall = (model: string, prompt: string) => budgetGuard.canReserve(estimateWorstCaseTurnCost(model, prompt, true));
    const refreshUsageFromLedger = async () => {
      const { data: usage, error } = await svc.from("llm_call_log").select("tokens_in,tokens_out,cost_usd").eq("run_id", run.id);
      if (error || !usage) throw new Error("council_call_usage_ledger_unavailable");
      tokensIn = usage.reduce((sum: number, row: any) => sum + Number(row.tokens_in ?? 0), 0);
      tokensOut = usage.reduce((sum: number, row: any) => sum + Number(row.tokens_out ?? 0), 0);
      costUsd = usage.reduce((sum: number, row: any) => sum + Number(row.cost_usd ?? 0), 0);
      return costUsd;
    };
    try {
      for (const model of participants) {
        if (!canCall(model, independentPrompt)) { budgetExhausted = true; break; }
        try {
          const { result, parsed } = await invokeWithinBudget(svc, { runId: run.id, symbol: observation.symbol, requestedModel: model, role: "independent", round: 0, prompt: independentPrompt, timeoutMs: providerTimeoutMs, parse: true, snapshot }, invocationStartedAt, budgetGuard, refreshUsageFromLedger);
          const forecast = parsed as Forecast;
          forecasts.set(model, { initial: forecast, final: forecast, modelUsed: result.model });
        } catch (error) {
          // Invalid/model-fallback calls are logged as failed turns by invoke;
          // failures without an LLM response are omitted from the forecast set.
          await refreshUsageFromLedger();
          budgetGuard.syncRunSpend(run.id, costUsd);
          if (String(error).includes("daily_budget_exhausted_before_call")) { budgetExhausted = true; stopAll = true; }
          outcomes.push({ symbol: observation.symbol, model, issue: String(error).slice(0, 100) });
        }
      }

      for (let round = 1; round <= debateRounds && forecasts.size >= 2 && !budgetExhausted; round++) {
        const peers = [...forecasts.entries()].map(([model, value]) => ({ model, score: value.final.score, confidence: value.final.confidence, rationale: value.final.rationale, bull_case: value.final.bull_case, bear_case: value.final.bear_case }));
        for (const [model, value] of forecasts) {
          const prompt = `Frozen evidence:\n${snapshotText}\n\nPrior peer positions (evaluate their cited arguments; do not defer to popularity):\n${JSON.stringify(peers)}\n\nYour previous score was ${value.final.score}. In debate round ${round}, identify the strongest argument against your view and the strongest support for it, then revise or retain your score. Return the same JSON forecast schema as before, adding "change_rationale". Do not invent facts; cite only the frozen evidence. Be LEAN: rationale at most 300 characters, bull_case and bear_case at most 120 characters each, at most 3 evidence_citations with claims under 80 characters; the whole JSON object must fit in about 250 tokens or it will be cut off and discarded.${citationGuidance(snapshot as Record<string, unknown>)}`;
          if (!canCall(model, prompt)) { budgetExhausted = true; break; }
          try {
            const { result, parsed } = await invokeWithinBudget(svc, { runId: run.id, symbol: observation.symbol, requestedModel: model, role: "debate", round, prompt, timeoutMs: providerTimeoutMs, parse: true, snapshot }, invocationStartedAt, budgetGuard, refreshUsageFromLedger);
            value.final = parsed as Forecast;
          } catch (error) {
            await refreshUsageFromLedger(); budgetGuard.syncRunSpend(run.id, costUsd);
            if (String(error).includes("daily_budget_exhausted_before_call")) { budgetExhausted = true; stopAll = true; }
            outcomes.push({ symbol: observation.symbol, model, round, issue: String(error).slice(0, 100) });
          }
        }
      }

      const finalEntries = [...forecasts.entries()];
      const finalProviderCount = new Set(finalEntries.map(([model]) => providerForModel(model)).filter(Boolean)).size;
      const finalScores = finalEntries.map(([, value]) => value.final.score);
      const consensus = !hybrid && validCouncilConsensus(participants.length, finalEntries.length, finalProviderCount) ? medianScore(finalScores) : null;
      const finalReports = [...forecasts.entries()].map(([model, value]) => ({ model, initial_score: value.initial.score, final_score: value.final.score, rationale: value.final.rationale, bull_case: value.final.bull_case, bear_case: value.final.bear_case }));
      let summary: string | null = null;
      let dissent: string | null = null;
      if (!hybrid && consensus != null && canCall(config.orchestrator_model, `evidence=${snapshotText}; reports=${JSON.stringify(finalReports)}`)) {
        const orchestratorPrompt = `Frozen evidence:\n${snapshotText}\n\nIndependent/debated model reports:\n${JSON.stringify(finalReports)}\n\nThe deterministic composite of valid final model scores is ${consensus}/100 (median). Do not change that composite. Return JSON only: {"synthesis": string, "main_disagreement": string, "key_risks": string[], "confidence_note": string}. Explain the strongest evidence for and against, distinguish cited facts from uncertainty, and list exact input as-of dates or unknowns. Be compact: synthesis at most 700 characters, main_disagreement at most 300 characters, at most 4 key_risks of under 120 characters each; the whole JSON object must fit in about 450 tokens or it will be cut off and discarded.`;
        try {
          const { result, parsed } = await invokeWithinBudget(svc, { runId: run.id, symbol: observation.symbol, requestedModel: config.orchestrator_model, role: "orchestrator", round: 0, prompt: orchestratorPrompt, timeoutMs: providerTimeoutMs, parse: true }, invocationStartedAt, budgetGuard, refreshUsageFromLedger);
          const o = parsed as any;
          if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("orchestrator_output_invalid");
          summary = typeof o.synthesis === "string" ? o.synthesis.slice(0, 4000) : null;
          dissent = [o.main_disagreement, ...(Array.isArray(o.key_risks) ? o.key_risks : [])].filter((x) => typeof x === "string").join("\n").slice(0, 3000);
        } catch (error) { await refreshUsageFromLedger(); budgetGuard.syncRunSpend(run.id, costUsd); outcomes.push({ symbol: observation.symbol, role: "orchestrator", issue: String(error).slice(0, 100) }); }
      }

      await refreshUsageFromLedger();
      const forecastRows = [...forecasts.entries()].map(([model, value]) => ({
        run_id: run.id, model_requested: model, model_used: value.modelUsed, provider: providerForModel(model),
        initial_score: value.initial.score, final_score: value.final.score, confidence: value.final.confidence,
        initial_rationale: value.initial.rationale, final_rationale: value.final.rationale,
        bull_case: value.final.bull_case, bear_case: value.final.bear_case,
        evidence_citations: value.final.evidence_citations, status: "completed",
      }));
      if (forecastRows.length) {
        const { error } = await svc.from("llm_council_model_forecasts").insert(forecastRows);
        if (error) throw new Error(`forecast_persist_failed:${error.message}`);
      }
      if (hybrid) {
        try {
          // Hybrid councils never debate: the database would add a second job per member (doubling Claude/Codex work).
          const batchId = await enqueueSubscription(svc, { ...config, debate_rounds: 0 }, snapshot, Number(observation.id));
          outcomes.push({ symbol: observation.symbol, status: "api_forecasts_complete_subscription_pending", batchId, apiModels: forecastRows.length, selectedApiModels: participants.length });
        } catch (error) {
          await svc.from("llm_council_runs").update({ status: "partial", tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd, failure_code: "hybrid_subscription_queue_refused", completed_at: new Date().toISOString() }).eq("id", run.id).eq("status", "running");
          outcomes.push({ symbol: observation.symbol, status: "subscription_queue_refused", issue: String(error).slice(0, 180) });
        }
        dailySpend += costUsd;
        return;
      }
      const status = consensus == null ? (budgetExhausted ? "budget_skipped" : "failed") : budgetExhausted || forecastRows.length < participants.length || !summary ? "partial" : "completed";
      const { error: finishError } = await svc.from("llm_council_runs").update({
        status, consensus_score: consensus, consensus_summary: summary, disagreement_summary: dissent,
        tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
        failure_code: consensus == null ? (budgetExhausted ? "daily_budget_exhausted" : "no_valid_forecasts") : null,
        completed_at: new Date().toISOString(),
      }).eq("id", run.id);
      if (finishError) throw new Error(`run_finalize_failed:${finishError.message}`);
      dailySpend += costUsd;
      outcomes.push({ symbol: observation.symbol, status, consensusScore: consensus, validModels: forecastRows.length, costUsd, tokensIn, tokensOut });
    } catch (error) {
      const { error: finalizeError } = await svc.from("llm_council_runs").update({ status: "failed", tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd, failure_code: "collection_failed", completed_at: new Date().toISOString() }).eq("id", run.id);
      outcomes.push({ symbol: observation.symbol, status: finalizeError ? "failed_to_finalize" : "failed", issue: String(error).slice(0, 180) });
    }
  };
  // Bounded concurrency + a runtime guard: a few symbols overlap, and no new symbol starts after ~200 s so the
  // invocation finishes inside maxDuration. Remaining symbols are picked up by the next scheduled invocation.
  let cursor = 0;
  let processed = 0;
  const poolSize = Math.max(1, Math.min(6, candidates.length));
  await Promise.all(Array.from({ length: poolSize }, async () => {
    while (!stopAll && cursor < candidates.length && Date.now() - invocationStartedAt < 200_000) {
      const next = candidates[cursor++];
      await processObservation(next);
      processed++;
    }
  }));
  return NextResponse.json({ market: requestedMarket, candidates: candidates.length, processed, remainingUnscored: rankedCandidates.length - processed, cohort: COUNCIL_ALL_RESEARCH_COHORT_KEY, cohortHalfWidthPoints: COUNCIL_COHORT_HALF_WIDTH, outcomes, dailySpendUsd: dailySpend, shadowOnly: true });
}
