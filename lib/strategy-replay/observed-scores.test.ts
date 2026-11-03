import {describe,it,expect,vi} from "vitest";
import {alignObservedScores,attachObservedScores} from "./observed-scores";
import {compileStrategyTemplate} from "./template-compiler";
import {compileSpec,evaluateEntryAtClose,type Bar} from "./compile";

const bars:Bar[]=["2026-10-29","2026-10-30"].map(session=>({session,open:10,high:11,low:9,close:10}));
const observation=(extra={})=>({id:1,ts:"2026-10-29T14:00:00Z",market:"us",entry_eligible:false,
  availability_mask:{macro:true},macro_score:0,...extra});
const compiled=compileStrategyTemplate({id:"test",name:"recorded macro",rules:{macro_score_max:30}},
  {market:"us",universe:["ABC"],horizonSessions:2});
if(!compiled.ok)throw new Error("fixture failed");
const spec=compiled.spec;

describe("recorded score timing contract",()=>{
  it("keeps real zero, rejects unavailable/inapplicable values, and never fills absent days",()=>{
    const aligned=alignObservedScores("us",bars,[observation()]);
    expect(aligned[0].observation?.values.macro_score).toBe(0);
    expect(aligned[1].observation).toBeUndefined();
    expect(evaluateEntryAtClose(spec,aligned.slice(0,1))).toBe(true);
    for(const extra of [{availability_mask:{macro:false}},{dimension_applicability:{dimensions:{macro:{state:"not_applicable"}}}}]){
      expect(evaluateEntryAtClose(spec,alignObservedScores("us",bars,[observation(extra)]).slice(0,1))).toBeNull();
    }
  });
  it("rejects after-close, other-market, invalid and nonregular-session observations",()=>{
    for(const extra of [{ts:"2026-10-29T21:00:00Z"},{market:"india"},{ts:"bad"},{ts:"2026-10-31T14:00:00Z"}]){
      expect(alignObservedScores("us",bars,[observation(extra)])[0].observation).toBeUndefined();
    }
  });
  it("uses one coherent latest snapshot; a missing latest dimension cannot inherit an older vote",()=>{
    const rows=[observation(),observation({id:2,ts:"2026-10-29T15:00:00Z",availability_mask:{macro:false}})];
    const aligned=alignObservedScores("us",bars,rows);
    expect(aligned[0].observation?.id).toBe(2);
    expect(evaluateEntryAtClose(spec,aligned.slice(0,1))).toBeNull();
  });
  it("records last-bar decisions without manufacturing a future bar or fill",()=>{
    const aligned=alignObservedScores("us",bars.slice(0,1),[observation()]);
    expect(evaluateEntryAtClose(spec,aligned)).toBe(true);
    expect(compileSpec({spec,bars:{ABC:aligned},initialCash:1000}).events).toHaveLength(0);
    expect(compileSpec({spec:{...spec,execution:"same_close"},bars:{ABC:aligned},initialCash:1000}).errors.join()).toContain("look-ahead");
    expect(compiled.compilerVersion).toBe("template-observed-score-compiler-v3");
  });
  it("fails on unavailable source history instead of reconstructing scores",async()=>{
    const q:any={};for(const name of ["select","eq","gte","lte","order"])q[name]=()=>q;
    q.range=vi.fn().mockResolvedValue({data:null,error:{message:"offline"}});
    await expect(attachObservedScores({from:()=>q},"us","ABC",bars)).rejects.toThrow("cannot be reconstructed");
  });
});
