import { describe, expect, it, vi } from "vitest";
import { referenceDiscoveryPlan,runReferenceStrategyDiscovery } from "./reference-discovery";
import { autonomouslyStartTemplateShadow } from "./autonomous-template-discovery";

const source = (id: string, rules: Record<string, unknown>) => ({ id, name: id, rules });
describe("reference strategy experiment construction", () => {
  it("retains unsupported conditions as capability blockers and never weakens a template", () => {
    const result = referenceDiscoveryPlan([source("a", { rsi_min: 60, sentiment_min: 70 }), source("b", { rsi_min: 60 })], "us", 5);
    expect(result.capabilities[0].supported).toBe(false);
    expect(result.attempts.every(row => row.parents.every(parent => parent.id === "b"))).toBe(true);
  });
  it("keeps India separate and preserves a supported three-condition reference strategy", () => {
    const trend = source("a", { above_ma200: true, ma50_above_ma200: true, pct_from_52w_high_max: 15 });
    const result = referenceDiscoveryPlan([trend, source("b", { rsi_min: 60 })], "india", 5);
    expect(result.attempts.filter(row=>row.parents.length)).toHaveLength(3);
    expect(result.attempts.every(row => row.assetClass === "india")).toBe(true);
    expect(result.attempts[0].parents[0].rules).toEqual(trend.rules);
  });
  it("does not optimize conflicting parent thresholds or duplicate nested conditions", () => {
    expect(referenceDiscoveryPlan([source("a", { rsi_min: 55 }), source("b", { rsi_min: 65 })], "india", 5).attempts.filter(row=>row.parents.length)).toHaveLength(2);
    expect(referenceDiscoveryPlan([source("a", { above_ma50: true }), source("b", { above_ma50: true, rsi_min: 60 })], "india", 5).attempts.filter(row=>row.parents.length)).toHaveLength(2);
  });
  it("bounds work and keeps stable source order independent of input order", () => {
    const catalog = [source("c", { above_ma50: true }), source("a", { rsi_min: 60 }), source("b", { above_ma200: true })];
    const left = referenceDiscoveryPlan(catalog, "us", 5);
    expect(left.attempts).toHaveLength(20);
    expect(left.attempts).toEqual(referenceDiscoveryPlan([...catalog].reverse(), "us", 5).attempts);
  });
});

describe("historical trial integrity", () => {
  function fixture(frozen = "2026-10-01", registrationError = false) {
    const cutoffs: string[] = [];
    const rpc = vi.fn().mockResolvedValue({ data: {was_new:true,evaluation_as_of:frozen,fingerprint:"a".repeat(64)}, error: registrationError ? { message: "unavailable" } : null });
    const from = vi.fn((table: string) => {
      const data = table === "strategy_validation_automation" ? { enabled: true, auto_shadow_enabled: true, max_active_shadows: 1 }
        : table === "agent_signals" ? [{ symbol: "AMD", asset_class: "us_equity" }]
        : table === "trial_family_ledger" ? { spec: { evaluation_as_of: frozen } } : [];
      const result = { data, error: null };
      const q: any = { then: (ok: any, fail: any) => Promise.resolve(result).then(ok, fail) };
      for (const name of ["select","eq","neq","gte","order","limit","in"]) q[name] = () => q;
      q.lte = (_column: string, value: string) => { cutoffs.push(value); return q; };
      q.single = q.maybeSingle = () => Promise.resolve(result);
      return q;
    });
    return { svc: { from, rpc }, cutoffs, rpc };
  }
  const input = { market: "us" as const, assetClass: "us_equity" as const, rules: { rsi_min: 60 }, horizonSessions: 5 as const,
    rationale: "Immutable threshold hypothesis for historical diagnostics", requestedModel: "deterministic", runId: null,
    now: new Date("2026-11-03T17:00:00Z"), diagnosticOnly: true };
  it("registers a trial even when missing historical prices prevent a shadow", async () => {
    const {svc,rpc,cutoffs} = fixture();
    expect((await autonomouslyStartTemplateShadow(svc,input)).status).toBe("historical_gate_failed");
    expect(rpc.mock.calls.map(call => call[0])).toEqual(["register_strategy_template_trial"]);
    expect(cutoffs.length).toBeGreaterThan(0);
    expect(cutoffs.every(value => value === "2026-10-01")).toBe(true);
  });
  it("refuses unfrozen historical replays and failed trial registration", async () => {
    await expect(autonomouslyStartTemplateShadow(fixture("").svc,input)).rejects.toThrow("cutoff missing");
    await expect(autonomouslyStartTemplateShadow(fixture("2026-10-01",true).svc,input)).rejects.toThrow("registration failed");
  });
});

describe("natural discovery continuation",()=>{
  it("persists a bounded cycle and resumes deferred dimensions without an LLM or new schedule",async()=>{
    let prior:any=null;const updates:any[]=[];let nextId=0;
    const svc={from:(table:string)=>{
      let insert=false,update:any=null;
      const result=()=>({error:null,data:insert ? {id:`run-${++nextId}`} : update ? []
        : table==="strategy_templates" ? [] : prior ? {workload_metrics:{discovery:prior}} : null});
      const q:any={then:(ok:any)=>Promise.resolve(result()).then(ok)};
      for(const method of ["select","eq","neq","order","limit"])q[method]=()=>q;
      q.insert=()=>{insert=true;return q;};
      q.update=(data:any)=>{update=data;updates.push(data);if(data.workload_metrics?.discovery)prior=data.workload_metrics.discovery;return q;};
      q.single=q.maybeSingle=async()=>result();return q;
    }};
    const evaluate=vi.fn().mockResolvedValue({status:"historical_gate_failed",detail:"No recorded labels"});
    const input={market:"us" as const,parentRunId:"natural-parent",minHold:2,maxHold:20};
    const first=await runReferenceStrategyDiscovery(svc,input,evaluate,()=>Date.parse("2026-11-03T18:00:00Z"));
    expect(evaluate).toHaveBeenCalledTimes(6);
    expect(first.status).toBe("budget_deferred");
    expect(first.nextAttempt).toBe(6);
    expect(updates[0]).toMatchObject({status:"done"});
    const second=await runReferenceStrategyDiscovery(svc,input,evaluate,()=>Date.parse("2026-11-10T18:00:00Z"));
    expect(second.status).toBe("evaluated");
    expect(evaluate.mock.calls[6][1].rules).toEqual({macro_score_min:70});
    expect(second.activation).toBeNull();
  });
});
