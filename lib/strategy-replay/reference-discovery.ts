import { autonomouslyStartTemplateShadow, type AutonomousAssetClass, type AutonomousTemplateResult } from "./autonomous-template-discovery";
import { compileStrategyTemplate, type StrategyTemplateSource } from "./template-compiler";
import {createHash} from "node:crypto";

export const REFERENCE_DISCOVERY_VERSION = "reference-seeds-recorded-dimensions-v2";
export type ReferenceAttempt = { parents: StrategyTemplateSource[]; assetClass: AutonomousAssetClass; rules?:Record<string,unknown> };

/** Fixed catalog order, never sorted by historical returns. No unsupported rule is dropped. */
export function referenceDiscoveryPlan(catalog: StrategyTemplateSource[], market: "us" | "india", horizon: number) {
  const capabilities = [...catalog].sort((a,b) => a.id.localeCompare(b.id)).map(template => {
    const compiled = compileStrategyTemplate(template, { market, universe: [market === "india" ? "RELIANCE.NS" : "VOO"], horizonSessions: horizon });
    return { template, supported: compiled.ok, reasons: compiled.ok ? [] : compiled.errors };
  });
  const families: AutonomousAssetClass[] = market === "india" ? ["india"] : ["us_equity", "etf"];
  const supported = capabilities.filter(row => row.supported).map(row => row.template).slice(0, market === "india" ? 6 : 3);
  const seeds:ReferenceAttempt[] = supported.flatMap(template => families.map(assetClass => ({ parents: [template], assetClass })));
  const pairs: ReferenceAttempt[] = [];
  for (let a=0; a<supported.length; a++) for (let b=a+1; b<supported.length; b++) {
    // A conflicting parameter is not an implicitly optimized threshold.
    if (Object.entries(supported[a].rules ?? {}).some(([key,value]) => key in (supported[b].rules ?? {}) && supported[b].rules![key] !== value)) continue;
    const parentA = Object.keys(supported[a].rules ?? {}), parentB = Object.keys(supported[b].rules ?? {});
    if (new Set([...parentA, ...parentB]).size <= Math.max(parentA.length, parentB.length)) continue;
    for (const assetClass of families) pairs.push({ parents: [supported[a], supported[b]], assetClass });
  }
  // Fixed score hypotheses use archived observations, not reconstructed historical scores.
  const dimensions=["fundamental","technical","sentiment","macro","insider"];
  const dimensionSeeds:ReferenceAttempt[]=dimensions.flatMap(dimension=>families.map(assetClass=>({
    parents:[],assetClass,rules:{[`${dimension}_score_min`]:70},
  })));
  const dimensionPairs:ReferenceAttempt[]=families.flatMap(assetClass=>[
    {parents:[],assetClass,rules:{fundamental_score_min:70,technical_score_min:70}},
    {parents:[],assetClass,rules:{sentiment_score_min:70,macro_score_min:70}},
  ]);
  return { capabilities, attempts: [...seeds,...dimensionSeeds,...pairs.slice(0,2),...dimensionPairs.slice(0,2)] };
}

export async function runReferenceStrategyDiscovery(svc: any, input: {
  market: "us" | "india"; parentRunId: string | null; minHold: number; maxHold: number;
}, evaluate = autonomouslyStartTemplateShadow, clock = Date.now) {
  const started = clock();
  const startedAt = new Date(started).toISOString();
  const row = await svc.from("agent_runs").insert({ agent_type: "strategy_discovery", market: input.market,
    status: "running", started_at: startedAt, trigger_source: "learner", prompt_version: REFERENCE_DISCOVERY_VERSION }).select("id").single();
  if (row.error || !row.data?.id) throw new Error("Discovery run could not be persisted");
  const outcomes: Array<Record<string, unknown>> = [];
  try {
    const horizon = ([5,10,2,20] as const).find(value => value >= input.minHold && value <= input.maxHold);
    if (!horizon) throw new Error("No supported discovery horizon inside the market mandate");
    const source = await svc.from("strategy_templates").select("id,name,description,rules").order("id").limit(201);
    if (source.error) throw new Error("Reference strategy catalog unavailable");
    if ((source.data?.length ?? 0)>200) throw new Error("Reference catalog exceeds the audited bounded inventory; refusing a truncated catalog");
    const { capabilities, attempts } = referenceDiscoveryPlan(source.data ?? [], input.market, horizon);
    const planFingerprint=createHash("sha256").update(JSON.stringify({version:REFERENCE_DISCOVERY_VERSION,horizon,attempts})).digest("hex");
    const previous=await svc.from("agent_runs").select("workload_metrics").eq("market",input.market).eq("agent_type","strategy_discovery")
      .neq("id",row.data.id).order("started_at",{ascending:false}).limit(1).maybeSingle();
    if(previous.error)throw new Error("Discovery continuation worklist unavailable");
    const prior=previous.data?.workload_metrics?.discovery;
    const samePlan=prior?.planFingerprint===planFingerprint;
    const startIndex=samePlan && Number.isInteger(prior.nextAttempt) && prior.nextAttempt>=0 && prior.nextAttempt<attempts.length ? prior.nextAttempt : 0;
    const cache = new Map<string, any>();
    const eligibleIndexes:number[]=samePlan && Array.isArray(prior.pendingEligibleIndexes) ? prior.pendingEligibleIndexes.filter((n:unknown)=>Number.isInteger(n) && Number(n)>=0 && Number(n)<attempts.length) : [];
    let seedCount=0,pairCount=0;
    for (const [relativeIndex,attempt] of attempts.slice(startIndex).entries()) {
      if (clock()-started >= 45_000) break;
      const pair=attempt.parents.length===2 || Object.keys(attempt.rules ?? {}).length===2;
      if(pair ? pairCount>=4 : seedCount>=6)break;
      if(pair)pairCount++;else seedCount++;
      const result = await evaluate(svc, { market: input.market, assetClass: attempt.assetClass,
        rules: attempt.rules ?? {}, horizonSessions: horizon, rationale: "Fixed reference catalog experiment; no optimized historical thresholds.",
        requestedModel: "deterministic", runId: input.parentRunId, now: new Date(started),
        referenceTemplates: attempt.parents.length ? attempt.parents : undefined, cache, diagnosticOnly: true });
      outcomes.push({ parentIds: attempt.parents.map(parent => parent.id), rules:attempt.rules, assetClass: attempt.assetClass,
        status: result.status, detail: result.detail, historicalEvidence: result.historicalEvidence ?? null });
      if (result.status === "historical_eligible") eligibleIndexes.push(startIndex+relativeIndex);
    }
    let activation: AutonomousTemplateResult | null = null;
    if (eligibleIndexes.length && clock()-started < 45_000) {
      const first = attempts[eligibleIndexes[0]];
      activation = await evaluate(svc, { market: input.market, assetClass: first.assetClass, rules: first.rules ?? {}, horizonSessions: horizon,
        rationale: "First historically eligible fixed-order reference; requires independent forward proof.", requestedModel: "deterministic",
        runId: input.parentRunId, now: new Date(started), referenceTemplates: first.parents.length ? first.parents : undefined, cache });
    }
    const nextIndex=startIndex+outcomes.length;
    const result = { version: REFERENCE_DISCOVERY_VERSION, parentRunId: input.parentRunId,planFingerprint,
      status: outcomes.length && outcomes.every(row=>row.status==="automation_disabled") ? "automation_disabled" : nextIndex < attempts.length ? "budget_deferred" : attempts.length ? "evaluated" : "no_supported_seeds",
      nextAttempt:nextIndex<attempts.length ? nextIndex : 0,pendingEligibleIndexes:[...new Set(eligibleIndexes)].filter((_,index)=>index!==0 || !["started","already_registered"].includes(activation?.status ?? "")),
      horizon, catalogCount: capabilities.length, supportedCount: capabilities.filter(row => row.supported).length,
      capabilities: capabilities.map(row => ({ id: row.template.id, name: row.template.name, supported: row.supported, reasons: row.reasons })),
      attempted: outcomes, deferred: attempts.length-nextIndex, activation };
    const saved = await svc.from("agent_runs").update({ status: "done", completed_at: new Date(clock()).toISOString(),
      result_summary: `${result.status}: ${outcomes.length}/${attempts.length} fixed reference trials`, workload_metrics: { discovery: result } }).eq("id", row.data.id);
    if (saved.error) throw new Error("Discovery outcome persistence failed");
    return result;
  } catch (error) {
    await svc.from("agent_runs").update({ status: "error", completed_at: new Date(clock()).toISOString(),
      result_summary: "Discovery stopped; no success inferred", workload_metrics: { discovery: { version: REFERENCE_DISCOVERY_VERSION, attempted: outcomes } } }).eq("id", row.data.id);
    throw error;
  }
}
