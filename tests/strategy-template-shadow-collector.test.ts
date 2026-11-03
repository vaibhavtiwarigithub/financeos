import { describe, expect, it } from "vitest";
import { collectTemplateShadowEvidence, priceBasisForResearchSource } from "@/lib/strategy-replay/template-shadow-collector";
import {compileStrategyTemplate} from "@/lib/strategy-replay/template-compiler";

const config = {
  id: "cfg-1", strategy_version_id: 7, rule_version: "template-rule-compiler-v2",
  rule_spec: { market: "us", universe: ["ABC"], horizonSessions: 2 },
};

function service(configs: unknown[]) {
  return { from: () => {
    const query: any = {
      select: () => query,
      eq: () => query,
      limit: async () => ({ data: configs, error: null }),
    };
    return query;
  } };
}

describe("strategy template shadow collection", () => {
  it("persists the last close decision against its preclose baseline, never the following research score",async()=>{
    const compiled=compileStrategyTemplate({id:"macro",name:"macro",rules:{macro_score_min:70}},
      {market:"us",universe:["ABC"],horizonSessions:2});
    if(!compiled.ok)throw new Error("fixture invalid");
    const writes:any[]=[];
    const svc={from:(table:string)=>{
      let write=false;
      const data=()=>table==="strategy_template_shadow_configs" ? [{...config,rule_spec:compiled.spec}]
        : table==="decision_observations" ? [
          {id:7,market:"us",ts:"2026-10-30T14:00:00Z",entry_eligible:false,macro_score:80,availability_mask:{macro:true}},
          {id:8,market:"us",ts:"2026-10-30T21:00:00Z",entry_eligible:true,macro_score:20,availability_mask:{macro:true}}]
        : write ? [{id:1}] : [];
      const q:any={then:(ok:any)=>Promise.resolve({data:data(),error:null}).then(ok)};
      for(const name of ["select","eq","limit","gte","lte","order","range","in"])q[name]=()=>q;
      q.upsert=(row:any)=>{writes.push(row);write=true;return q;};return q;
    }};
    const candles=["2026-10-29","2026-10-30"].map(date=>({date,open:10,high:11,low:9,close:10,volume:100}));
    const result=await collectTemplateShadowEvidence({supabase:svc,market:"us",symbol:"ABC",candles,source:"yahoo",
      observationId:99,baselineEntryEligible:true});
    expect(result.decisionsInserted).toBe(1);
    expect(writes[0]).toMatchObject({signal_session:"2026-10-30",observation_id:7,would_enter:true,baseline_entry_eligible:false});
  });
  it("maps only registered research sources to an explicit price basis", () => {
    expect(priceBasisForResearchSource("yahoo")).toBe("adjusted");
    expect(priceBasisForResearchSource("UPSTOX")).toBe("raw");
    expect(priceBasisForResearchSource("unknown-provider")).toBe("unknown");
  });

  it("does not fail research when no forward shadow is active", async () => {
    const result = await collectTemplateShadowEvidence({
      supabase: service([]), market: "us", symbol: "ABC", candles: [], source: "unknown-provider",
      observationId: null, baselineEntryEligible: false,
    });
    expect(result).toMatchObject({ activeConfigs: 0, decisionsInserted: 0, outcomesInserted: 0 });
  });

  it("surfaces unknown price provenance for an active matching shadow", async () => {
    await expect(collectTemplateShadowEvidence({
      supabase: service([config]), market: "us", symbol: "ABC", candles: [], source: "unknown-provider",
      observationId: null, baselineEntryEligible: false,
    })).rejects.toThrow("no approved price basis");
  });

  it("surfaces malformed completed bars instead of silently losing shadow observations", async () => {
    const invalid = [
      { date: "2026-10-29", open: 10, high: 9, low: 8, close: 8.5, volume: 100 },
      { date: "2026-10-30", open: 9, high: 9.5, low: 8.5, close: 9.25, volume: 100 },
    ];
    await expect(collectTemplateShadowEvidence({
      supabase: service([config]), market: "us", symbol: "ABC", candles: invalid, source: "yahoo",
      observationId: null, baselineEntryEligible: false,
    })).rejects.toThrow("invalid completed candles");
  });
});
