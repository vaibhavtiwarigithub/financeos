import { createHash } from "node:crypto";
import { benchmarkSymbolFor } from "@/lib/data/benchmark-registry";
import { parseTemplateShadowRequest } from "./template-shadow-contract";
import { compileStrategyTemplate, type StrategyTemplateSource } from "./template-compiler";
import { runTemplateBacktest } from "./template-backtest";
import type { Bar } from "./compile";
import type { RuleSpec } from "./rule-spec";
import { isMissingStrategyLabSchemaObject } from "./schema-errors";
import { LEVERAGED_SLEEVE_SYMBOLS } from "@/lib/trading/leveraged-sleeve-risk";
import { isLeveragedInverseEtf } from "@/lib/trading/symbol-policy";
import {attachObservedScores,needsObservedScores} from "./observed-scores";

export const AUTONOMOUS_TEMPLATE_DISCOVERY_VERSION = "learner-generated-recorded-input-v2";
export const AUTONOMOUS_RULE_COMPILER_VERSION = "template-rule-compiler-v2";
const MAX_UNIVERSE = 10;
const MAX_BARS = 750;
const INITIAL_CASH = 100_000;

export type AutonomousTemplateResult = {
  status: "started" | "historical_eligible" | "already_registered" | "capacity_full" | "no_researched_symbols" | "not_supported" | "historical_gate_failed" | "automation_disabled" | "error";
  detail: string;
  configId?: string;
  label?: string;
  historicalEvidence?: unknown;
  trialFingerprint?: string;
};

const PARAMETER_GRID: Record<string, number[]> = {
  ...Object.fromEntries(["fundamental","technical","sentiment","macro","insider"].flatMap(dimension =>
    ["min","max"].map(bound=>[`${dimension}_score_${bound}`,[30,50,70]]))),
  rsi_min: [55, 60, 65, 70],
  rsi_max: [25, 30, 35, 40],
  pct_from_52w_high_max: [5, 10, 15, 20],
  pct_below_52w_high_min: [10, 15, 20, 25, 30],
};
const BOOLEAN_RULES = new Set(["above_ma50", "above_ma200", "ma50_above_ma200"]);

export function validateAutonomousPriceRules(value: unknown): { ok: true; rules: Record<string, unknown> } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "rules must be an object" };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 2) return { ok: false, reason: "propose one or two allowlisted rule conditions" };
  const rules: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    if (BOOLEAN_RULES.has(key)) {
      if (raw !== true) return { ok: false, reason: `${key} must be true` };
      rules[key] = true;
      continue;
    }
    const allowed = PARAMETER_GRID[key];
    if (!allowed) return { ok: false, reason: `${key} is outside the active recorded-input rule grammar` };
    if (typeof raw !== "number" || !allowed.includes(raw)) return { ok: false, reason: `${key} must use a preregistered value: ${allowed.join(", ")}` };
    rules[key] = raw;
  }
  if (typeof rules.rsi_min === "number" && typeof rules.rsi_max === "number" && rules.rsi_min > rules.rsi_max) {
    return { ok: false, reason: "rsi_min cannot exceed rsi_max; the combined condition would be impossible" };
  }
  for(const dimension of ["fundamental","technical","sentiment","macro","insider"]){
    const low=rules[`${dimension}_score_min`],high=rules[`${dimension}_score_max`];
    if(typeof low==="number" && typeof high==="number" && low>high)return {ok:false,reason:`${dimension} score bounds are contradictory`};
  }
  return { ok: true, rules };
}

/**
 * LearnerAgent may propose a small, finite price-rule grammar and a universe
 * drawn from recently researched names. The deterministic compiler, fixed-cost
 * replay, slot limit and database lifecycle RPC own every state transition.
 * The LLM cannot supply code or a raw RuleSpec.
 */
export async function autonomouslyStartTemplateShadow(supabase: any, input: {
  market: "us" | "india";
  assetClass: "us_equity" | "adr" | "etf" | "metal" | "leveraged_etf" | "india";
  rules: unknown;
  horizonSessions: 2 | 5 | 10 | 20;
  rationale: string;
  requestedModel: string;
  promptVersion?: string;
  runId: string | null;
  now?: Date;
  /** Internal reference catalog path; never exposed to model tool arguments. */
  referenceTemplates?: StrategyTemplateSource[];
  cache?: Map<string, any>;
  diagnosticOnly?: boolean;
}): Promise<AutonomousTemplateResult> {
  const policyResult = await supabase.from("strategy_validation_automation")
    .select("enabled,auto_shadow_enabled,max_active_shadows").eq("market", input.market).maybeSingle();
  if (policyResult.error) throw new Error(`strategy automation policy read failed: ${policyResult.error.message}`);
  if (policyResult.data?.enabled !== true || policyResult.data?.auto_shadow_enabled !== true) {
    return { status: "automation_disabled", detail: "Market-local strategy automation is disabled." };
  }

  const configsResult = await supabase.from("strategy_template_shadow_configs")
    .select("id,state,config_fingerprint").eq("market", input.market).neq("state", "retired");
  if (configsResult.error) {
    if (isMissingStrategyLabSchemaObject(configsResult.error)) return { status: "error", detail: "Strategy lab schema is not deployed." };
    throw new Error(`strategy capacity read failed: ${configsResult.error.message}`);
  }
  const configs = configsResult.data ?? [];
  const configuredCapacity = Number(policyResult.data?.max_active_shadows);
  const activeCapacity = Number.isInteger(configuredCapacity) ? Math.max(0, Math.min(3, configuredCapacity)) : 0;
  if (!input.diagnosticOnly && configs.length >= activeCapacity) return { status: "capacity_full", detail: `All ${activeCapacity} market-local strategy slots are occupied.` };

  const references = input.referenceTemplates;
  if (references && (references.length < 1 || references.length > 2)) return { status: "not_supported", detail: "Reference discovery supports one seed or two confirmation parents." };
  const mergedRules: Record<string, unknown> = {};
  for (const reference of references ?? []) {
    for (const [key, value] of Object.entries(reference.rules ?? {})) {
      if (key in mergedRules && mergedRules[key] !== value) return { status: "not_supported", detail: `Conflicting parent rule: ${key}` };
      mergedRules[key] = value;
    }
  }
  const validatedRules = references ? { ok: true as const, rules: mergedRules } : validateAutonomousPriceRules(input.rules);
  if (!validatedRules.ok) return { status: "not_supported", detail: validatedRules.reason };

  if ((input.market === "india") !== (input.assetClass === "india")) {
    return { status: "not_supported", detail: "The selected asset family does not belong to this market." };
  }
  const universeKey = `universe:${input.market}:${input.assetClass}`;
  const universe = input.cache?.get(universeKey) ?? await recentlyResearchedUniverse(supabase, input.market, input.assetClass, input.now ?? new Date());
  input.cache?.set(universeKey, universe);
  if (universe.length === 0) return { status: "no_researched_symbols", detail: "No eligible market-local symbols were researched in the last 14 days." };
  const ruleIdentity = JSON.stringify(Object.fromEntries(Object.entries(validatedRules.rules).sort(([a], [b]) => a.localeCompare(b))));
  const stableId = references?.length === 1 ? references[0].id : deterministicUuid(`${input.market}:${AUTONOMOUS_RULE_COMPILER_VERSION}:${ruleIdentity}`);
  const generatedTemplate = {
    id: stableId,
    name: references ? references.map(row => row.name).join(" + ") : `Kairos AI ${input.market.toUpperCase()} ${stableId.slice(0, 8)}`,
    description: `Autonomous learner proposal. ${input.rationale.trim().slice(0, 240)}`,
    rules: validatedRules.rules,
  };
  const compiled = compileStrategyTemplate(generatedTemplate, {
    market: input.market, universe, horizonSessions: input.horizonSessions,
  });
  if (!compiled.ok) return { status: "not_supported", detail: compiled.errors.join("; ") };

  // Extend the existing family rather than resetting multiplicity for the v3 grammar.
  const trialFamilyId = `autonomous-rule:${input.market}:${AUTONOMOUS_RULE_COMPILER_VERSION}`;
  const parsed = parseTemplateShadowRequest({
    market: input.market, template_ids: references ? references.map(row => row.id) : [stableId],
    kind: references?.length === 2 ? "combination" : "template", operator: references?.length === 2 ? "confirmation" : "single", weights: {},
    rule_version: compiled.compilerVersion, trial_family_id: trialFamilyId, rule_spec: compiled.spec,
  });
  if (!parsed.ok) return { status: "not_supported", detail: parsed.errors.join("; ") };
  const { value } = parsed;
  const trial = await supabase.rpc("register_strategy_template_trial", {
    p_market:input.market,p_template_ids:value.templateIds,p_kind:value.kind,p_operator:value.operator,p_weights:value.weights,
    p_rule_version:compiled.compilerVersion,p_trial_family_id:trialFamilyId,p_rule_spec:compiled.spec,
    p_evaluation_as_of:(input.now ?? new Date()).toISOString().slice(0,10),
  });
  if (trial.error) throw new Error(`pre-screen trial registration failed: ${trial.error.message}`);
  const frozenAsOf = trial.data?.evaluation_as_of;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(frozenAsOf ?? "")) throw new Error("Historical evaluation cutoff missing; refusing an unfrozen replay");
  const cutoff=new Date(`${frozenAsOf}T23:59:59Z`);
  const baseDiagnostic = await loadDiagnostic(supabase, compiled.spec, cutoff, input.cache);
  const parentComparisons=[];
  if(references?.length===2)for(const parent of references){
    const parentSpec=compileStrategyTemplate(parent,{market:input.market,universe,horizonSessions:input.horizonSessions});
    if(!parentSpec.ok)throw new Error("Combination parent no longer compiles under its frozen contract");
    parentComparisons.push({parentId:parent.id,evidence:await loadDiagnostic(supabase,parentSpec.spec,cutoff,input.cache)});
  }
  const diagnostic={...baseDiagnostic,parentComparisons,
    comparisonContract:"Identical frozen universe, cutoff, sessions and costs; no best-parent fitting or promotion from historical returns."};
  const holdout = diagnostic.holdout;
  if (diagnostic.status !== "diagnostic_only" || !holdout || holdout.sessions < 30 || holdout.trades < 1
    || holdout.unpricedSessions !== 0 || holdout.benchmarkMissingSessions !== 0 || holdout.excessReturnPp == null) {
    const failures = historicalScreenBlockers(diagnostic);
    return { status: "historical_gate_failed", detail: failures.join("; "), historicalEvidence: diagnostic,trialFingerprint:trial.data.fingerprint };
  }
  if (input.diagnosticOnly) return { status: "historical_eligible", detail: "Frozen data screen passed; forward selection evidence is still required.", label: compiled.spec.label, historicalEvidence: diagnostic };

  const existingTemplate = await supabase.from("strategy_templates").select("id,rules")
    .eq("id", stableId).maybeSingle();
  if (existingTemplate.error) throw new Error(`strategy catalog read failed: ${existingTemplate.error.message}`);
  if (existingTemplate.data && JSON.stringify(Object.fromEntries(Object.entries(existingTemplate.data.rules ?? {}).sort(([a],[b])=>a.localeCompare(b)))) !== ruleIdentity) {
    throw new Error("deterministic strategy identity collision; candidate was refused");
  }
  if (!existingTemplate.data && !references) {
    const insertedTemplate = await supabase.from("strategy_templates").insert(generatedTemplate).select("id").single();
    if (insertedTemplate.error) {
      if (/duplicate key/i.test(insertedTemplate.error.message)) return { status: "already_registered", detail: "This exact rule identity is already registered." };
      throw new Error(`strategy hypothesis persistence failed: ${insertedTemplate.error.message}`);
    }
  }

  const provenance = {
    source: "learner_agent_autonomous_strategy_discovery",
    discovery_version: AUTONOMOUS_TEMPLATE_DISCOVERY_VERSION,
    requested_model: input.requestedModel,
    prompt_version: input.promptVersion ?? "unversioned",
    learner_run_id: input.runId,
    rationale: input.rationale.trim().slice(0, 500),
    universe: value.ruleSpec.universe,
    horizon_sessions: input.horizonSessions,
    asset_class: input.assetClass,
    historical_evidence: diagnostic,
  };
  const created = await supabase.rpc("create_strategy_template_shadow_config", {
    p_market: value.market, p_template_ids: value.templateIds, p_kind: value.kind,
    p_operator: value.operator, p_weights: value.weights, p_rule_version: value.ruleVersion,
    p_trial_family_id: value.trialFamilyId, p_rule_spec: value.ruleSpec,
    p_fingerprint: trial.data.fingerprint, p_historical_evidence: {...diagnostic,discovery_provenance:provenance},
  });
  if (created.error) {
    if (isMissingStrategyLabSchemaObject(created.error)) return { status: "error", detail: "Strategy lab schema is not deployed." };
    if (/capacity reached/i.test(created.error.message)) return { status: "capacity_full", detail: "Market-local strategy capacity was reached concurrently." };
    throw new Error(`strategy registration failed: ${created.error.message}`);
  }
  const config = Array.isArray(created.data) ? created.data[0] : created.data;
  if (!config?.id) throw new Error("strategy registration returned no configuration id");
  if (config.state === "shadow") return { status: "already_registered", detail: "This frozen strategy is already collecting forward evidence.", configId: config.id, label: compiled.spec.label, historicalEvidence: diagnostic };
  if (config.state !== "draft") return { status: "already_registered", detail: `Existing strategy is ${config.state}; no transition was attempted.`, configId: config.id, label: compiled.spec.label, historicalEvidence: diagnostic };

  const transitioned = await supabase.rpc("transition_strategy_template_shadow_config", {
    p_config_id: config.id,
    p_event: "shadow",
    p_reason: "autonomous:historical_screen_passed_forward_shadow_started",
    p_evidence_snapshot: provenance,
  });
  if (transitioned.error) {
    if (/capacity reached/i.test(transitioned.error.message)) return { status: "capacity_full", detail: "Shadow capacity was reached concurrently.", configId: config.id };
    throw new Error(`automatic shadow start failed: ${transitioned.error.message}`);
  }
  return { status: "started", detail: "Registered and started a bounded, non-executing forward shadow after the fixed historical-data gate.", configId: config.id, label: compiled.spec.label, historicalEvidence: diagnostic };
}

export function historicalScreenBlockers(diagnostic:any):string[] {
  const failures:string[]=[];
  const holdout=diagnostic?.holdout;
  if(diagnostic?.status!=="diagnostic_only")failures.push(String(diagnostic?.limitation ?? "historical inputs insufficient"));
  if(!holdout)return [...failures,"no evaluable holdout"];
  if(holdout.sessions<30)failures.push(`holdout sessions ${holdout.sessions}/30`);
  if(holdout.trades<1)failures.push("no completed holdout entries");
  if(holdout.unpricedSessions!==0)failures.push(`unpriced holdout sessions: ${holdout.unpricedSessions ?? "unknown"}`);
  if(holdout.benchmarkMissingSessions!==0)failures.push(`missing benchmark sessions: ${holdout.benchmarkMissingSessions ?? "unknown"}`);
  if(holdout.excessReturnPp==null)failures.push("paired benchmark excess unavailable");
  return failures.length ? failures : ["historical input gate unavailable"];
}

function deterministicUuid(name: string): string {
  const namespace = Buffer.from("f17f4b4bbf86475ea84f719e010b8750", "hex");
  const digest = createHash("sha1").update(Buffer.concat([namespace, Buffer.from(name, "utf8")])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function recentlyResearchedUniverse(supabase: any, market: "us" | "india", assetClass: AutonomousAssetClass, now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const dbAssetClass = assetClass === "leveraged_etf" ? "etf" : assetClass;
  const result = await supabase.from("agent_signals").select("symbol,created_at,asset_class")
    .eq("market", market).eq("asset_class", dbAssetClass)
    .gte("created_at", since).order("created_at", { ascending: false }).limit(500);
  if (result.error) throw new Error(`market-local researched universe read failed: ${result.error.message}`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of result.data ?? []) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    const valid = isEligibleResearchSymbol(symbol, market);
    if (!valid || seen.has(symbol)) continue;
    if (assetClass === "leveraged_etf" ? !LEVERAGED_SLEEVE_SYMBOLS.has(symbol)
      : assetClass === "etf" && isLeveragedInverseEtf(symbol)) continue;
    seen.add(symbol); out.push(symbol);
    if (out.length >= MAX_UNIVERSE) break;
  }
  return out;
}

export type AutonomousAssetClass = "us_equity" | "adr" | "etf" | "metal" | "leveraged_etf" | "india";

export function isEligibleResearchSymbol(symbol: string, market: "us" | "india"): boolean {
  if (market === "india") return /^[A-Z0-9&_-]+\.(NS|BO)$/.test(symbol);
  if (/\.(NS|BO)$/.test(symbol)) return false;
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) && !/-USD$/.test(symbol);
}

async function loadDiagnostic(supabase: any, spec: RuleSpec, now: Date, cache?: Map<string, any>) {
  const benchmark = benchmarkSymbolFor(spec.market, "strategy_replay");
  const symbols = [...new Set([...spec.universe, benchmark])];
  const asOf = now.toISOString().slice(0, 10);
  const results = await Promise.all(symbols.map(async (symbol) => {
    const key = `bars:${symbol}:${asOf}`;
    if (cache?.has(key)) return cache.get(key);
    const { data, error } = await supabase.from("price_cache")
      .select("symbol,date,open,high,low,close,provider,price_basis,provenance_version")
      .eq("symbol", symbol).neq("provenance_version", "v0_unprovenanced")
      .in("price_basis", ["raw", "adjusted"]).lte("date", asOf)
      .order("date", { ascending: false }).limit(MAX_BARS);
    if (error) throw new Error(`${symbol} price cache read failed: ${error.message}`);
    const rows = (data ?? []).reverse();
    cache?.set(key, rows);
    return rows;
  }));
  const rows = results.flat();
  const bySymbol: Record<string, Bar[]> = {};
  for (const row of rows as any[]) {
    const bar = { session: String(row.date).slice(0,10), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) };
    if (![bar.open,bar.high,bar.low,bar.close].every((n) => Number.isFinite(n) && n > 0)) continue;
    (bySymbol[row.symbol] ??= []).push(bar);
  }
  const provenance = (rows as any[]).map((row) => ({ provider: row.provider, priceBasis: row.price_basis, provenanceVersion: row.provenance_version }));
  for (const series of Object.values(bySymbol)) series.sort((a,b) => a.session.localeCompare(b.session));
  if(needsObservedScores(spec))for(const symbol of spec.universe){
    if(bySymbol[symbol])bySymbol[symbol]=await attachObservedScores(supabase,spec.market,symbol,bySymbol[symbol],cache);
  }
  const priceBases = [...new Set(provenance.map((row) => row.priceBasis))];
  if (priceBases.length > 1) return {
    status: "insufficient_data", method: "fixed-rule-70-30-temporal-holdout-v1", market: spec.market,
    benchmark, dataFrom: null, dataThrough: null, symbols: Object.keys(bySymbol).length, bars: rows.length,
    priceSources: [...new Set(provenance.map((row) => row.provider))], priceBases,
    provenanceVersions: [...new Set(provenance.map((row) => row.provenanceVersion))], warmup: null,
    inSample: null, holdout: null, limitation: "Mixed raw/adjusted price bases; cross-symbol replay refused.",
  };
  return runTemplateBacktest({ spec, bars: bySymbol, benchmark, benchmarkBars: bySymbol, provenance, initialCash: INITIAL_CASH });
}
