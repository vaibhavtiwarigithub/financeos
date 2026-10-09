import { NextRequest, NextResponse } from "next/server";
import { callLLM, isReasoningModel, priceFor } from "@/lib/llm-router";
import { providerForModel, getProviderKey } from "@/lib/llm-keys";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { isEntryCandidateLong } from "@/lib/learning/entry-cohort";
import { extractJson, medianScore, parseForecast, sha256, validateForecastCitations, type Forecast } from "@/lib/llm-council/core";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_TURN_TOKENS = 900;
// At the maximum configuration (3 participants × 4 turns + orchestrator), a
// 12s hard timeout leaves ample room for persistence/finalization in 300s.
const PROVIDER_TIMEOUT_MS = 12_000;
const MAX_TURN_CHARS = 45_000;
const SYSTEM = "You are a research analyst in a shadow-only stock research experiment. Use only the supplied frozen evidence. Do not use or invent current facts from model memory. If a field has no source/as-of timestamp, say its date is unknown. Cite factual claims using evidence paths from the snapshot and their recorded as-of date. Output exactly one RFC 8259 JSON object using straight ASCII double quotes; no smart quotes, markdown fences, comments, trailing commas, or surrounding prose. Escape quotes inside strings. This opinion never places or changes trades.";

function estimateCost(model: string, prompt: string, maxOutput = MAX_TURN_TOKENS): number {
  const [inputRate, outputRate] = priceFor(model);
  // Deliberately pessimistic input estimate: one token per character, not the
  // usual ~3-4 characters/token. This is a reservation guard, not billing.
  const effectiveOutputBudget = isReasoningModel(model) ? Math.max(maxOutput, 16_000) : maxOutput;
  return (prompt.length / 1_000_000 * inputRate) + (effectiveOutputBudget / 1_000_000 * outputRate);
}

function asSnapshot(row: any) {
  return {
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
  args: { runId: string; symbol: string; requestedModel: string; role: "independent" | "debate" | "orchestrator"; round: number; prompt: string; parse?: boolean; snapshot?: unknown },
) {
  const provider = providerForModel(args.requestedModel);
  const persist = async (row: Record<string, unknown>) => {
    const { error } = await svc.from("llm_council_turns").insert({
      run_id: args.runId, model_requested: args.requestedModel, model_used: null,
      turn_role: args.role, round: args.round, prompt_sha256: sha256(args.prompt),
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
      maxTokens: MAX_TURN_TOKENS, timeoutMs: PROVIDER_TIMEOUT_MS, symbol: args.symbol, agentLabel: "llm-council", runId: args.runId,
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

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const requestedMarket = new URL(req.url).searchParams.get("market");
  if (requestedMarket !== "us" && requestedMarket !== "india") return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  const svc = createServiceClient();
  const { data: config, error: configError } = await svc.from("llm_council_config").select("*").eq("id", "global").single();
  if (configError || !config) return NextResponse.json({ error: "LLM council migration is not installed" }, { status: 503 });
  if (!config.enabled) return NextResponse.json({ skipped: "disabled" });

  const now = new Date();
  // Provider/process timeouts can leave a unique observation stuck as running.
  // Finalize abandoned runs once so they remain visible instead of silently
  // blocking retries forever.
  const staleBefore = new Date(now.getTime() - 30 * 60_000).toISOString();
  const { data: staleRuns, error: staleReadError } = await svc.from("llm_council_runs")
    .select("id").eq("status", "running").lt("created_at", staleBefore).limit(100);
  if (staleReadError) return NextResponse.json({ error: "Could not inspect incomplete council runs" }, { status: 500 });
  for (const stale of staleRuns ?? []) {
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
  const dailyCount = (dailyRuns ?? []).filter((r: any) => r.market === requestedMarket && r.status !== "budget_skipped").length;
  const remainingSymbols = Math.max(0, Number(config.max_symbols_per_market_day) - dailyCount);
  if (remainingSymbols === 0) return NextResponse.json({ skipped: "daily_symbol_cap", dailySpend });
  const participants = (config.participant_models as string[]).filter((m) => !!providerForModel(m));
  const uniqueProviders = new Set(participants.map(providerForModel).filter(Boolean));
  if (participants.length < 2 || uniqueProviders.size < 2) return NextResponse.json({ error: "Council needs two configured models from distinct providers" }, { status: 409 });

  const { data: obsRows, error: obsError } = await svc.from("decision_observations")
    .select("id,ts,market,symbol,code_version,features,availability_mask,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,direction,entry_eligible,score_threshold,price_at_decision,currency,decision_context,discovery_source")
    .eq("market", requestedMarket).eq("entry_eligible", true).eq("direction", "long")
    .gte("ts", new Date(now.getTime() - 3 * 86_400_000).toISOString())
    .order("ts", { ascending: false }).limit(500);
  if (obsError) return NextResponse.json({ error: "Could not load frozen research observations" }, { status: 500 });
  const eligible = (obsRows ?? []).filter((row: any) => isEntryCandidateLong({
    entryEligible: row.entry_eligible, direction: row.direction, decisionContext: row.decision_context, discoverySource: row.discovery_source,
  }));
  const latestBySymbol = new Map<string, any>();
  for (const row of eligible) if (!latestBySymbol.has(row.symbol)) latestBySymbol.set(row.symbol, row);
  const rankedCandidates = [...latestBySymbol.values()].sort((a, b) => Number(b.analyst_score) - Number(a.analyst_score));
  const { data: existing } = rankedCandidates.length
    ? await svc.from("llm_council_runs").select("observation_id").in("observation_id", rankedCandidates.map((x) => x.id))
    : { data: [] };
  const done = new Set((existing ?? []).map((x: any) => Number(x.observation_id)));
  // One symbol per cron invocation keeps the worst-case three-model / three-round
  // sequence inside the function runtime. Five spaced invocations fill the daily cap.
  const candidates = rankedCandidates.filter((row) => !done.has(Number(row.id))).slice(0, Math.min(remainingSymbols, 1));

  const outcomes: Array<Record<string, unknown>> = [];
  for (const observation of candidates) {
    const snapshot = await addPointInTimeRelationships(svc, observation, asSnapshot(observation));
    const snapshotText = JSON.stringify(snapshot);
    const independentPrompt = `Frozen decision-time evidence JSON (all numbers must come from this object):\n${snapshotText}\n\nScore this symbol's relative attractiveness over the next 10 market sessions. Give a score from 0 (least attractive) to 100 (most attractive), NOT a price target or return percent. Be independent: do not assume the deterministic score is correct. Return exactly one valid JSON object matching this schema (the type labels below are descriptions, not literal output): {"score": number, "confidence": number from 0 to 1, "rationale": string, "bull_case": string, "bear_case": string, "evidence_citations": [{"claim": string, "source": "existing JSON path or field", "as_of": "timestamp/date or 'unknown'"}]}. Use straight ASCII double quotes only. No smart quotes, code fence, comments, trailing comma, or text before/after the object. Provide at least one citation. Cite only paths that exist in the supplied snapshot and give only the timestamp that belongs to that data field, or "unknown" when it has no source timestamp. Explicitly state missing/stale data and what could falsify your view.`;
    if (dailySpend + estimateCost(participants[0], SYSTEM + independentPrompt) > Number(config.daily_budget_usd)) {
      outcomes.push({ symbol: observation.symbol, status: "skipped", issue: "daily_budget_cannot_reserve_first_forecast" });
      break;
    }
    const configSnapshot = {
      participant_models: participants,
      orchestrator_model: config.orchestrator_model,
      debate_rounds: config.debate_rounds,
      max_symbols_per_market_day: config.max_symbols_per_market_day,
      daily_budget_usd: config.daily_budget_usd,
    };
    const { data: run, error: createError } = await svc.from("llm_council_runs").insert({
      observation_id: observation.id, market: requestedMarket, symbol: observation.symbol, decision_ts: observation.ts,
      status: "running", input_snapshot: snapshot, input_sha256: sha256(snapshotText), config_snapshot: configSnapshot,
      prompt_version: config.prompt_version,
    }).select("id").single();
    if (createError || !run) {
      outcomes.push({ symbol: observation.symbol, status: "already_started_or_persist_failed" });
      continue;
    }

    let tokensIn = 0, tokensOut = 0, costUsd = 0;
    const forecasts = new Map<string, { initial: Forecast; final: Forecast; modelUsed: string }>();
    let budgetExhausted = false;
    const canCall = (model: string, prompt: string) => {
      const reserve = estimateCost(model, SYSTEM + prompt);
      if (dailySpend + costUsd + reserve > Number(config.daily_budget_usd)) return false;
      return true;
    };
    const refreshUsageFromLedger = async () => {
      const { data: usage } = await svc.from("llm_call_log").select("tokens_in,tokens_out,cost_usd").eq("run_id", run.id);
      if (!usage) return;
      tokensIn = usage.reduce((sum: number, row: any) => sum + Number(row.tokens_in ?? 0), 0);
      tokensOut = usage.reduce((sum: number, row: any) => sum + Number(row.tokens_out ?? 0), 0);
      costUsd = usage.reduce((sum: number, row: any) => sum + Number(row.cost_usd ?? 0), 0);
    };
    try {
      for (const model of participants) {
        if (!canCall(model, independentPrompt)) { budgetExhausted = true; break; }
        try {
          const { result, parsed } = await invoke(svc, { runId: run.id, symbol: observation.symbol, requestedModel: model, role: "independent", round: 0, prompt: independentPrompt, parse: true, snapshot });
          await refreshUsageFromLedger();
          const forecast = parsed as Forecast;
          forecasts.set(model, { initial: forecast, final: forecast, modelUsed: result.model });
        } catch (error) {
          // Invalid/model-fallback calls are logged as failed turns by invoke;
          // failures without an LLM response are omitted from the forecast set.
          await refreshUsageFromLedger();
          outcomes.push({ symbol: observation.symbol, model, issue: String(error).slice(0, 100) });
        }
      }

      for (let round = 1; round <= Number(config.debate_rounds) && forecasts.size >= 2 && !budgetExhausted; round++) {
        const peers = [...forecasts.entries()].map(([model, value]) => ({ model, score: value.final.score, confidence: value.final.confidence, rationale: value.final.rationale, bull_case: value.final.bull_case, bear_case: value.final.bear_case }));
        for (const [model, value] of forecasts) {
          const prompt = `Frozen evidence:\n${snapshotText}\n\nPrior peer positions (evaluate their cited arguments; do not defer to popularity):\n${JSON.stringify(peers)}\n\nYour previous score was ${value.final.score}. In debate round ${round}, identify the strongest argument against your view and the strongest support for it, then revise or retain your score. Return the same JSON forecast schema as before, adding "change_rationale". Do not invent facts; cite only the frozen evidence.`;
          if (!canCall(model, prompt)) { budgetExhausted = true; break; }
          try {
            const { result, parsed } = await invoke(svc, { runId: run.id, symbol: observation.symbol, requestedModel: model, role: "debate", round, prompt, parse: true, snapshot });
            await refreshUsageFromLedger();
            value.final = parsed as Forecast;
          } catch (error) { await refreshUsageFromLedger(); outcomes.push({ symbol: observation.symbol, model, round, issue: String(error).slice(0, 100) }); }
        }
      }

      const finalEntries = [...forecasts.entries()];
      const finalProviderCount = new Set(finalEntries.map(([model]) => providerForModel(model)).filter(Boolean)).size;
      const finalScores = finalEntries.map(([, value]) => value.final.score);
      const consensus = finalEntries.length >= 2 && finalProviderCount >= 2 ? medianScore(finalScores) : null;
      const finalReports = [...forecasts.entries()].map(([model, value]) => ({ model, initial_score: value.initial.score, final_score: value.final.score, rationale: value.final.rationale, bull_case: value.final.bull_case, bear_case: value.final.bear_case }));
      let summary: string | null = null;
      let dissent: string | null = null;
      if (consensus != null && canCall(config.orchestrator_model, `evidence=${snapshotText}; reports=${JSON.stringify(finalReports)}`)) {
        const orchestratorPrompt = `Frozen evidence:\n${snapshotText}\n\nIndependent/debated model reports:\n${JSON.stringify(finalReports)}\n\nThe deterministic composite of valid final model scores is ${consensus}/100 (median). Do not change that composite. Return JSON only: {"synthesis": string, "main_disagreement": string, "key_risks": string[], "confidence_note": string}. Explain the strongest evidence for and against, distinguish cited facts from uncertainty, and list exact input as-of dates or unknowns.`;
        try {
          const { result, parsed } = await invoke(svc, { runId: run.id, symbol: observation.symbol, requestedModel: config.orchestrator_model, role: "orchestrator", round: 0, prompt: orchestratorPrompt, parse: true });
          await refreshUsageFromLedger();
          const o = parsed as any;
          if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("orchestrator_output_invalid");
          summary = typeof o.synthesis === "string" ? o.synthesis.slice(0, 4000) : null;
          dissent = [o.main_disagreement, ...(Array.isArray(o.key_risks) ? o.key_risks : [])].filter((x) => typeof x === "string").join("\n").slice(0, 3000);
        } catch (error) { await refreshUsageFromLedger(); outcomes.push({ symbol: observation.symbol, role: "orchestrator", issue: String(error).slice(0, 100) }); }
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
  }
  return NextResponse.json({ market: requestedMarket, candidates: candidates.length, outcomes, dailySpendUsd: dailySpend, shadowOnly: true });
}
