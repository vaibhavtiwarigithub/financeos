import { beforeEach,describe,expect,it,vi } from "vitest";
import { defaultAllocation } from "@/lib/allocation/profiles";
const health=vi.hoisted(()=>({report:vi.fn(),resolve:vi.fn()}));
vi.mock("@/lib/system-health",()=>({reportIssue:health.report,resolveIssue:health.resolve}));
import {loadPaperAllocation,savePaperAllocation} from "@/lib/allocation/profile-store";
function fixture(){
  const rows=new Map<string,string>();let failed=false;
  const svc:any={from:(table:string)=>{let key="",raw:string|undefined,mode="read",payload:any;
    const q:any={select:()=>q,limit:()=>q,eq:(name:string,value:string)=>{if(name==="key")key=value;else if(name==="value")raw=value;return q;},
      insert:(value:any)=>{mode="insert";payload=value;key=value.key;return q;},update:(value:any)=>{mode="update";payload=value;return q;},
      maybeSingle:async()=>{if(failed)return{error:{message:"offline"},data:null};if(table==="strategy_config")return{data:{risk_profile:"aggressive"}};
        if(mode==="insert"){if(rows.has(key))return{error:{code:"23505"}};rows.set(key,payload.value);return{data:{key}};}
        if(mode==="update"){if(rows.get(key)!==raw)return{data:null};rows.set(key,payload.value);return{data:{key}};}
        return{data:rows.has(key)?{value:rows.get(key)}:null};}};return q;}};
  return{rows,svc,fail:()=>{failed=true;}};
}
describe("allocation persistence and reset isolation",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("loads explicit defaults but refuses corrupt/unavailable saved settings",async()=>{
    const f=fixture();expect(await loadPaperAllocation(f.svc,"us")).toMatchObject({ok:true,policy:{profile:"aggressive",revision:0}});
    f.rows.set("paper_allocation:us","{");expect((await loadPaperAllocation(f.svc,"us")).ok).toBe(false);expect(health.report).toHaveBeenCalled();
    f.fail();expect((await loadPaperAllocation(f.svc,"india")).ok).toBe(false);
  });
  it("saves custom edits, detects stale revisions and resets the selected market only",async()=>{
    const f=fixture(),p=defaultAllocation("us","growth");f.rows.set("paper_allocation:india",JSON.stringify(defaultAllocation("india")));
    const india=f.rows.get("paper_allocation:india");
    const body={...p,expectedRevision:0,targets:{...p.targets,gold:9,individual:36}};
    expect(await savePaperAllocation(f.svc,body)).toMatchObject({status:200,policy:{revision:1,targets:{gold:9}}});
    expect((await savePaperAllocation(f.svc,body)).status).toBe(409);
    expect(await savePaperAllocation(f.svc,{...body,expectedRevision:1,reset:true,targets:{bad:99}})).toMatchObject({status:200,policy:{revision:2,targets:{gold:10,individual:35}}});
    expect(f.rows.get("paper_allocation:india")).toBe(india);
    const loaded=await loadPaperAllocation(f.svc,"us");if(!loaded.ok)throw Error("fixture");expect(loaded.policy.history).toHaveLength(2);
  });
  it("rejects invalid money/market input without persisting a partial record",async()=>{
    const f=fixture(),p=defaultAllocation("india");
    expect((await savePaperAllocation(f.svc,{...p,expectedRevision:0,leveragedMaxPct:5})).status).toBe(400);
    expect(f.rows.size).toBe(0);
    expect((await savePaperAllocation(f.svc,{...p,expectedRevision:0,targets:{...p.targets,gold:50}})).status).toBe(400);
  });
});
