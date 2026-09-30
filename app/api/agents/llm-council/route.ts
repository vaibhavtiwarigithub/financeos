import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getProviderKey, providerForModel } from "@/lib/llm-keys";
import { isConfigurableModel } from "@/lib/llm-model-catalog";

export const dynamic = "force-dynamic";

function validParticipants(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 3
    && value.every(isConfigurableModel)
    && new Set(value).size === value.length
    && new Set(value.map((model) => providerForModel(model))).size >= 2;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase();
  const market = req.nextUrl.searchParams.get("market");
  const [config, cells] = await Promise.all([
    svc.from("llm_council_config").select("*").eq("id", "global").single(),
    svc.from("llm_council_ic_runs").select("*").order("evaluated_at", { ascending: false }).limit(1000),
  ]);
  if (config.error) return NextResponse.json({ error: "LLM council schema is not installed" }, { status: 503 });
  if (cells.error) return NextResponse.json({ error: "Could not load council evaluation evidence" }, { status: 500 });
  let runsQuery = svc.from("llm_council_runs").select("id,symbol,market,decision_ts,status,consensus_score,consensus_summary,disagreement_summary,tokens_in,tokens_out,cost_usd,created_at").order("created_at", { ascending: false }).limit(symbol ? 5 : 25);
  if (symbol) runsQuery = runsQuery.eq("symbol", symbol);
  if (market === "us" || market === "india") runsQuery = runsQuery.eq("market", market);
  const { data: runs, error: runsError } = await runsQuery;
  if (runsError) return NextResponse.json({ error: "Could not load council runs" }, { status: 500 });
  const runIds = (runs ?? []).map((row: any) => row.id);
  const [forecasts, turns] = runIds.length ? await Promise.all([
    svc.from("llm_council_model_forecasts").select("run_id,model_requested,model_used,initial_score,final_score,confidence,initial_rationale,final_rationale,bull_case,bear_case,evidence_citations,status").in("run_id", runIds),
    svc.from("llm_council_turns").select(symbol ? "run_id,model_requested,model_used,turn_role,round,output_json,output_text,tokens_in,tokens_out,cost_usd,status,created_at" : "run_id,model_requested,model_used,turn_role,round,tokens_in,tokens_out,cost_usd,status,created_at").in("run_id", runIds).order("round", { ascending: true }).limit(1000),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (forecasts.error || turns.error) return NextResponse.json({ error: "Could not load council model evidence" }, { status: 500 });
  return NextResponse.json({ config: config.data, runs: runs ?? [], forecasts: forecasts.data ?? [], turns: turns.data ?? [], ic: cells.data ?? [] });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  const svc = createServiceClient();
  const { data: current, error: readError } = await svc.from("llm_council_config").select("*").eq("id", "global").single();
  if (readError || !current) return NextResponse.json({ error: "LLM council schema is not installed" }, { status: 503 });

  const next = { ...current, ...body };
  if (body.participant_models !== undefined && !validParticipants(body.participant_models)) {
    return NextResponse.json({ error: "Choose 2–3 distinct supported models from at least 2 providers" }, { status: 400 });
  }
  if (!validParticipants(next.participant_models)) return NextResponse.json({ error: "At least two distinct provider models are required" }, { status: 400 });
  if (!isConfigurableModel(next.orchestrator_model)) return NextResponse.json({ error: "Unsupported orchestrator model" }, { status: 400 });
  if (!Number.isInteger(next.debate_rounds) || next.debate_rounds < 0 || next.debate_rounds > 3) return NextResponse.json({ error: "Debate rounds must be from 0 to 3" }, { status: 400 });
  if (!Number.isInteger(next.max_symbols_per_market_day) || next.max_symbols_per_market_day < 1 || next.max_symbols_per_market_day > 5) return NextResponse.json({ error: "Daily symbol limit must be from 1 to 5 per market" }, { status: 400 });
  if (!Number.isFinite(Number(next.daily_budget_usd)) || Number(next.daily_budget_usd) < 0 || Number(next.daily_budget_usd) > 100) return NextResponse.json({ error: "Daily budget must be between $0 and $100" }, { status: 400 });
  if (typeof next.enabled !== "boolean") return NextResponse.json({ error: "Enabled must be boolean" }, { status: 400 });

  if (next.enabled) {
    const allModels = [...next.participant_models, next.orchestrator_model] as string[];
    const providers = [...new Set(allModels.map(providerForModel).filter((x): x is NonNullable<typeof x> => !!x))];
    for (const provider of providers) {
      if (!(await getProviderKey(provider, svc))) {
        return NextResponse.json({ error: `No API key configured for ${provider}; set it in Settings → AI Models before enabling the council` }, { status: 409 });
      }
    }
  }

  const update = {
    enabled: next.enabled,
    participant_models: next.participant_models,
    orchestrator_model: next.orchestrator_model,
    debate_rounds: next.debate_rounds,
    max_symbols_per_market_day: next.max_symbols_per_market_day,
    daily_budget_usd: Number(next.daily_budget_usd),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await svc.from("llm_council_config").update(update).eq("id", "global").select("*").single();
  if (error) return NextResponse.json({ error: "Could not save council settings" }, { status: 500 });
  return NextResponse.json({ config: data });
}
