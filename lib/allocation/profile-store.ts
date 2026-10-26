import { ALLOCATION_VERSION, ALLOCATION_PROFILES, ALLOCATION_RESEARCH_FUNDS, defaultAllocation, validateAllocation, selectAllocationResearchSeeds, type AllocationPolicy, type AllocationProfile } from "./profiles";
import { reportIssue, resolveIssue } from "@/lib/system-health";

async function readPaperAllocation(svc: any, market: "us" | "india", profile?: string) {
  try {
    const {data,error}=await svc.from("app_settings").select("value").eq("key",`paper_allocation:${market}`).maybeSingle();
    if(error) return {ok:false as const,error:"Allocation settings unavailable"};
    if(!data) {
      if(!profile) { const cfg=await svc.from("strategy_config").select("risk_profile").limit(1).maybeSingle();
        if(cfg.error) return {ok:false as const,error:"Allocation default profile unavailable"}; profile=cfg.data?.risk_profile; }
      const selected=ALLOCATION_PROFILES.includes(profile as AllocationProfile) ? profile as AllocationProfile : "balanced";
      return {ok:true as const,policy:defaultAllocation(market,selected),raw:null as string|null};
    }
    const policy=JSON.parse(data.value) as AllocationPolicy;
    const invalid=validateAllocation(policy,market);
    return invalid ? {ok:false as const,error:invalid} : {ok:true as const,policy,raw:data.value as string|null};
  } catch { return {ok:false as const,error:"Saved allocation could not be verified"}; }
}
export async function loadPaperAllocation(svc:any,market:"us"|"india",profile?:string) {
  const result=await readPaperAllocation(svc,market,profile);
  if(result.ok) await resolveIssue(`allocation-settings:${market}`,svc);
  else await reportIssue({issueKey:`allocation-settings:${market}`,severity:"warn",category:"data",
    title:`${market.toUpperCase()} paper allocation settings unavailable`,detail:result.error},svc);
  return result;
}
export async function savePaperAllocation(svc:any,body:any) {
  if(!body || !["us","india"].includes(body.market) || !ALLOCATION_PROFILES.includes(body.profile)
    || !Number.isInteger(body.expectedRevision) || body.expectedRevision<0 || typeof body.enabled!=="boolean")
    return {status:400,error:"Valid market, profile, enabled flag and expected revision required"};
  const current=await loadPaperAllocation(svc,body.market);
  if(!current.ok) return {status:503,error:current.error};
  if(current.policy.revision!==body.expectedRevision) return {status:409,error:"Allocation changed; reload before saving"};
  const defaults=defaultAllocation(body.market,body.profile);
  const savedAt=new Date().toISOString();
  const policy:AllocationPolicy={...defaults,enabled:body.enabled,revision:current.policy.revision+1,savedAt,
    targets:body.reset===true ? defaults.targets : body.targets,
    leveragedMaxPct:body.reset===true ? defaults.leveragedMaxPct : body.leveragedMaxPct,
    history:[...(current.policy.history??[]),{revision:current.policy.revision,profile:current.policy.profile,
      savedAt:current.policy.savedAt??savedAt,targets:current.policy.targets,leveragedMaxPct:current.policy.leveragedMaxPct,enabled:current.policy.enabled}].slice(-12)};
  const invalid=validateAllocation(policy,body.market);
  if(invalid) return {status:400,error:invalid};
  const row={key:`paper_allocation:${body.market}`,value:JSON.stringify(policy),updated_at:savedAt};
  const result=current.raw==null ? await svc.from("app_settings").insert(row).select("key").maybeSingle()
    : await svc.from("app_settings").update(row).eq("key",row.key).eq("value",current.raw).select("key").maybeSingle();
  if(result.error || !result.data) return {status:result.error?.code==="23505" || !result.error ? 409 : 500,error:"Allocation was not saved; reload and retry"};
  return {status:200,policy,version:ALLOCATION_VERSION};
}
export async function allocationResearchSeeds(svc:any,market:"us"|"india") {
  try{
    const loaded=await loadPaperAllocation(svc,market);if(!loaded.ok||!loaded.policy.enabled)return [];
    const all=Object.values(ALLOCATION_RESEARCH_FUNDS[market]).flat();
    const [pool,book,blocked]=await Promise.all([
      svc.from("paper_portfolio").select("cash_balance,updated_at").eq("market",market).maybeSingle(),
      svc.from("paper_positions").select("symbol,qty,current_price,avg_cost").eq("market",market),
      svc.from("watchlist").select("symbol").eq("market",market).eq("research_enabled",false).in("symbol",all),
    ]);
    if(pool.error||book.error||blocked.error||!pool.data)return [];
    const positions=(book.data??[]).map((p:any)=>({symbol:String(p.symbol),marketValue:Number(p.qty)*(Number(p.current_price)>0?Number(p.current_price):NaN)}));
    const cash=Number(pool.data.cash_balance),nav=cash+positions.reduce((sum:number,p:any)=>sum+p.marketValue,0);
    return selectAllocationResearchSeeds(loaded.policy,nav,cash,positions,new Set<string>((blocked.data??[]).map((r:any)=>String(r.symbol).toUpperCase())),pool.data.updated_at);
  }catch{return [];}
}
