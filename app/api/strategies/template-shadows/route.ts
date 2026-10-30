import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { benchmarkSymbolFor } from "@/lib/data/benchmark-registry";
import { parseTemplateShadowRequest } from "@/lib/strategy-replay/template-shadow-contract";
import { compileStrategyTemplate } from "@/lib/strategy-replay/template-compiler";
import { runTemplateBacktest } from "@/lib/strategy-replay/template-backtest";
import { isMissingStrategyLabSchemaObject } from "@/lib/strategy-replay/schema-errors";
import type { Bar } from "@/lib/strategy-replay/compile";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const MAX_BACKTEST_SYMBOLS = 10;
const MAX_BARS_PER_SYMBOL = 750;
const INITIAL_CASH = 100_000;

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = req.nextUrl.searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();
  const { data: configs, error } = await svc.from("strategy_template_shadow_configs")
    .select("*").eq("market", market).order("created_at", { ascending: false }).limit(20);
  if (error) {
    if (isMissingStrategyLabSchemaObject(error)) return NextResponse.json({ market, configs: [], status: "not_deployed" }, { status: 503 });
    return NextResponse.json({ error: "strategy_shadow_read_failed" }, { status: 500 });
  }
  const { data: templates, error: templateError } = await svc.from("strategy_templates")
    .select("id,name,description,rules").order("name");
  if (templateError) return NextResponse.json({ error: "strategy_template_read_failed" }, { status: 500 });
  const { data: automation, error: automationError } = await svc.from("strategy_validation_automation")
    .select("enabled,auto_shadow_enabled,max_active_shadows,auto_rule_paper_select_enabled").eq("market", market).maybeSingle();
  if (automationError) return NextResponse.json({ error: "strategy_automation_read_failed" }, { status: 500 });
  const { data: paperSelection, error: selectionError } = await svc.from("strategy_template_paper_selection")
    .select("market,config_id,evaluation_id,updated_at").eq("market", market).maybeSingle();
  if (selectionError) return NextResponse.json({ error: "strategy_paper_selection_read_failed" }, { status: 503 });
  const templateOptions = (templates ?? []).map((template: any) => {
    const compiled = compileStrategyTemplate(template, {
      market, universe: [market === "india" ? "RELIANCE.NS" : "VOO"], horizonSessions: 10,
    });
    return { ...template, supported: compiled.ok, unsupportedReasons: compiled.ok ? [] : compiled.errors };
  });

  let enriched: any[];
  try { enriched = await Promise.all((configs ?? []).map(async (config: any) => {
    const [events, decisionsResult, latestPaperEvaluation] = await Promise.all([
      fetchAllRows((from, to) => svc.from("strategy_template_shadow_events").select("event,reason,evidence_snapshot,created_at")
        .eq("config_id", config.id).order("created_at", { ascending: false }).range(from, to), "strategy template events"),
      svc.from("strategy_template_shadow_decisions").select("id,would_enter,baseline_entry_eligible,signal_session", { count: "exact" })
        .eq("config_id", config.id).order("signal_session", { ascending: false }).limit(1000),
      svc.from("strategy_template_paper_evaluations").select("status,selector_version,evidence,created_at")
        .eq("config_id", config.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (decisionsResult.error) throw new Error(`strategy template decisions read failed: ${decisionsResult.error.message}`);
    if (latestPaperEvaluation.error) throw new Error(`strategy paper evaluation read failed: ${latestPaperEvaluation.error.message}`);
    const decisions: any[] = decisionsResult.data ?? [];
    const decisionIds = decisions.map((row: any) => Number(row.id));
    const outcomes = decisionIds.length ? await fetchAllRows((from, to) => svc.from("strategy_template_shadow_outcomes")
      .select("decision_id,net_return_pct,matured_at").in("decision_id", decisionIds).range(from, to), "strategy template outcomes") : [];
    const outcomeByDecision = new Map(outcomes.map((row: any) => [Number(row.decision_id), Number(row.net_return_pct)]));
    const summarize = (filter: (row: any) => boolean) => {
      const rows = decisions.filter(filter).filter((row: any) => outcomeByDecision.has(Number(row.id)));
      const returns: number[] = rows.map((row: any) => Number(outcomeByDecision.get(Number(row.id))))
        .filter((value: number) => Number.isFinite(value));
      return {
        matured: returns.length,
        wins: returns.filter((value) => value > 0).length,
        hitRatePct: returns.length ? round(returns.filter((value) => value > 0).length / returns.length * 100) : null,
        meanNetReturnPct: returns.length ? round(returns.reduce((sum, value) => sum + value, 0) / returns.length) : null,
      };
    };
    const overlap = {
      bothEnter: summarize((row) => row.would_enter === true && row.baseline_entry_eligible === true),
      ruleOnly: summarize((row) => row.would_enter === true && row.baseline_entry_eligible === false),
      baselineOnly: summarize((row) => row.would_enter === false && row.baseline_entry_eligible === true),
      neither: summarize((row) => row.would_enter === false && row.baseline_entry_eligible === false),
    };
    const latestBacktest = events.find((row: any) => row.event === "backtest_completed" || row.event === "created")?.evidence_snapshot?.historical_evidence ?? null;
    return {
      ...config,
      latestPaperEvaluation: latestPaperEvaluation.data ?? null,
      evidence: {
        state: outcomeByDecision.size ? "descriptive_only" : "insufficient_evidence",
        decisionCount: decisionsResult.count ?? decisions.length,
        displayedDecisionWindow: decisions.length,
        maturedCount: outcomeByDecision.size,
        pendingCount: Math.max(0, decisions.length - outcomeByDecision.size),
        ruleSelected: summarize((row) => row.would_enter === true),
        deterministicEligible: summarize((row) => row.baseline_entry_eligible === true),
        overlap,
        latestBacktest,
        latestEvent: events[0] ?? null,
      },
    };
  })); } catch (error: any) {
    console.error("[strategy-template-shadows] evidence read failed:", error?.message ?? error);
    return NextResponse.json({ error: "strategy_shadow_evidence_read_failed" }, { status: 500 });
  }
  return NextResponse.json({ market, configs: enriched, templates: templateOptions, automation: automation ?? null,
    paperSelection: paperSelection ?? null, status: "ready", limits: { maxActive: 3,
      used: (configs ?? []).filter((row: any) => row.state !== "retired").length,
      maxUniverseSymbols: MAX_BACKTEST_SYMBOLS, maxBarsPerSymbol: MAX_BARS_PER_SYMBOL } });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  let body: Record<string, unknown>;
  try { const json = await req.json(); body = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {}; }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const market = body.market === "india" ? "india" : body.market === "us" ? "us" : null;
  const universe = Array.isArray(body.universe) ? body.universe.filter((value): value is string => typeof value === "string").map((value) => value.trim().toUpperCase()).filter(Boolean) : [];
  const horizonSessions = typeof body.horizon_sessions === "number" ? body.horizon_sessions : NaN;
  if (!market || !Number.isInteger(horizonSessions)) return NextResponse.json({ error: "invalid_template_compile_request" }, { status: 400 });
  if (!universe.length || universe.length > MAX_BACKTEST_SYMBOLS) return NextResponse.json({ error: "invalid_universe_size", max: MAX_BACKTEST_SYMBOLS }, { status: 400 });

  const svc = createServiceClient();
  const scan = body.action === "scan";
  if (scan && body.kind != null && body.kind !== "template") return NextResponse.json({ error: "only_predeclared_templates_supported" }, { status: 422 });
  const { data: current, error: currentError } = await svc.from("strategy_template_shadow_configs").select("id,state")
    .eq("market", market).neq("state", "retired");
  if (currentError) {
    if (isMissingStrategyLabSchemaObject(currentError)) return NextResponse.json({ error: "strategy_shadow_not_deployed" }, { status: 503 });
    return NextResponse.json({ error: "strategy_shadow_capacity_read_failed" }, { status: 500 });
  }
  const slots = Math.max(0, 3 - (current ?? []).length);
  if (scan && slots === 0) return NextResponse.json({ error: "market_shadow_capacity_reached", detail: "Retire or pause-review an existing configuration before starting another bounded scan." }, { status: 409 });
  const query = svc.from("strategy_templates").select("id,name,description,rules");
  if (!scan) {
    const templateId = typeof body.template_id === "string" ? body.template_id : null;
    if (!templateId) return NextResponse.json({ error: "template_id_required" }, { status: 400 });
    query.eq("id", templateId);
  }
  const { data: templates, error: templateError } = await query.order("name");
  if (templateError) return NextResponse.json({ error: "strategy_template_read_failed" }, { status: 500 });
  if (!templates?.length) return NextResponse.json({ error: "strategy_template_not_found" }, { status: 404 });

  const results: any[] = [];
  const candidates = scan ? templates : templates.slice(0, 1);
  const freeSlots = scan ? slots : 1;
  for (const template of candidates) {
    const compiled = compileStrategyTemplate(template, { market, universe, horizonSessions });
    if (!compiled.ok) {
      if (scan) continue;
      return NextResponse.json({ error: "template_not_compilable", details: compiled.errors }, { status: 422 });
    }
    const trialFamilyId = `template:${market}:${template.id}:${compiled.compilerVersion}`;
    const parsed = parseTemplateShadowRequest({ market, template_ids: [template.id], kind: "template", operator: "single", weights: {}, rule_version: compiled.compilerVersion, trial_family_id: trialFamilyId, rule_spec: compiled.spec });
    if (!parsed.ok) return NextResponse.json({ error: "invalid_template_shadow", details: parsed.errors }, { status: 400 });
    let historicalEvidence: any;
    try { historicalEvidence = await loadDiagnostic(svc, compiled.spec); }
    catch (error: any) { return NextResponse.json({ error: "historical_backtest_data_error", detail: String(error?.message ?? error).slice(0, 300) }, { status: 503 }); }
    const p = parsed.value;
    const { data, error } = await svc.rpc("create_strategy_template_shadow_config", {
      p_market: p.market, p_template_ids: p.templateIds, p_kind: p.kind,
      p_operator: p.operator, p_weights: p.weights, p_rule_version: p.ruleVersion,
      p_trial_family_id: p.trialFamilyId, p_rule_spec: p.ruleSpec,
      p_fingerprint: p.fingerprint, p_historical_evidence: historicalEvidence,
    });
    if (error) {
      if (isMissingStrategyLabSchemaObject(error)) return NextResponse.json({ error: "strategy_shadow_not_deployed" }, { status: 503 });
      if (scan && /capacity reached/i.test(error.message)) break;
      if (scan) { results.push({ name: template.name, error: error.message }); continue; }
      return NextResponse.json({ error: "strategy_shadow_refused", detail: error.message }, { status: 409 });
    }
    results.push({ config: Array.isArray(data) ? data[0] : data, historicalEvidence, compilerVersion: compiled.compilerVersion });
    if (results.length >= freeSlots) break;
  }
  if (!results.length) return NextResponse.json({ error: "no_supported_patterns", detail: "No fully price-based predeclared template is supported for this market." }, { status: 422 });
  return NextResponse.json({ configs: results, config: results[0].config, influence: "none", scan }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const configId = typeof body?.config_id === "string" ? body.config_id : "";
  const event = ["shadow", "paused", "resumed", "retired", "validating"].includes(body?.event) ? body.event : null;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 240) : "";
  if (!configId || !event || !reason) return NextResponse.json({ error: "config_id, valid event and reason are required" }, { status: 400 });
  const svc = createServiceClient();
  const { data, error } = await svc.rpc("transition_strategy_template_shadow_config", {
    p_config_id: configId, p_event: event, p_reason: reason,
    p_evidence_snapshot: { source: "learning_strategy_lab_ui", no_execution: true },
  });
  if (error) return NextResponse.json({ error: "strategy_shadow_transition_refused", detail: error.message }, { status: 409 });
  return NextResponse.json({ config: Array.isArray(data) ? data[0] : data, influence: "none" });
}

function round(value: number): number { return Math.round(value * 100) / 100; }

async function loadDiagnostic(svc: any, spec: import("@/lib/strategy-replay/rule-spec").RuleSpec) {
  const benchmark = benchmarkSymbolFor(spec.market, "strategy_replay");
  const symbols = [...new Set([...spec.universe, benchmark])];
  const asOf = new Date().toISOString().slice(0, 10);
  const results = await Promise.all(symbols.map(async (symbol) => {
    const { data, error } = await svc.from("price_cache").select("symbol,date,open,high,low,close,provider,price_basis,provenance_version")
      .eq("symbol", symbol).neq("provenance_version", "v0_unprovenanced")
      .in("price_basis", ["raw", "adjusted"]).lte("date", asOf).order("date", { ascending: false }).limit(MAX_BARS_PER_SYMBOL);
    if (error) throw new Error(`${symbol} price cache read failed: ${error.message}`);
    return (data ?? []).reverse();
  }));
  const rows = results.flat();
  const bySymbol: Record<string, Bar[]> = {};
  for (const row of rows as any[]) {
    const bar = { session: String(row.date).slice(0,10), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) };
    if (![bar.open,bar.high,bar.low,bar.close].every((value) => Number.isFinite(value) && value > 0)) continue;
    (bySymbol[row.symbol] ??= []).push(bar);
  }
  const provenance = (rows as any[]).map((row) => ({ provider: row.provider, priceBasis: row.price_basis, provenanceVersion: row.provenance_version }));
  for (const symbol of Object.keys(bySymbol)) bySymbol[symbol].sort((a,b) => a.session.localeCompare(b.session));
  const bases = [...new Set(provenance.map((row) => row.priceBasis))];
  if (bases.length > 1) return {
    status: "insufficient_data", method: "fixed-rule-70-30-temporal-holdout-v1",
    market: spec.market, benchmark, dataFrom: null, dataThrough: null, symbols: Object.keys(bySymbol).length,
    bars: rows.length, priceSources: [...new Set(provenance.map((row) => row.provider))], priceBases: bases,
    provenanceVersions: [...new Set(provenance.map((row) => row.provenanceVersion))], warmup: null,
    inSample: null, holdout: null, limitation: "Price series use mixed raw and adjusted bases; no cross-symbol backtest is calculated until the basis is reconciled.",
  };
  return runTemplateBacktest({ spec, bars: bySymbol, benchmark, benchmarkBars: bySymbol, provenance, initialCash: INITIAL_CASH });
}
