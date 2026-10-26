import { classifyInstrumentPolicy } from "@/lib/scoring/instrument-taxonomy";
import { LEVERAGED_SLEEVE_SYMBOLS, leveragedPaperEntrySize } from "@/lib/trading/leveraged-sleeve-risk";

export const ALLOCATION_VERSION = "allocation_presets_v1_20261026";
export const ALLOCATION_PROFILES = ["conservative", "balanced", "growth", "aggressive"] as const;
export type AllocationProfile = typeof ALLOCATION_PROFILES[number];
export const ALLOCATION_BUCKETS = ["core_etf", "individual", "sector_etf", "bonds", "gold", "silver", "oil", "tactical"] as const;
export type AllocationBucket = typeof ALLOCATION_BUCKETS[number];
export const ALLOCATION_LABELS: Record<AllocationBucket, string> = { core_etf: "Broad equity ETFs", individual: "Individual stocks", sector_etf: "Sector / thematic ETFs", bonds: "Bond / liquid ETFs", gold: "Gold bullion", silver: "Silver bullion", oil: "Oil / commodity funds", tactical: "Tactical cash + leveraged" };
export type AllocationPolicy = { market: "us" | "india"; profile: AllocationProfile; enabled: boolean;
  version: string; revision: number; targets: Record<AllocationBucket, number>; leveragedMaxPct: number;
  savedAt?: string; history?: Array<{ revision: number; profile: AllocationProfile; savedAt: string; targets: Record<AllocationBucket, number>; leveragedMaxPct: number; enabled: boolean }> };

export function defaultAllocation(market: "us" | "india", profile: AllocationProfile = "aggressive"): AllocationPolicy {
  const rows = { conservative: [30,5,0,50,10,0,0,5], balanced: [40,15,5,25,10,0,0,5], growth: [40,35,5,5,10,0,0,5], aggressive: [40,40,10,0,5,0,0,5] };
  return { market, profile, enabled: true, version: ALLOCATION_VERSION, revision: 0,
    targets: Object.fromEntries(ALLOCATION_BUCKETS.map((key,i) => [key,rows[profile][i]])) as Record<AllocationBucket,number>,
    leveragedMaxPct: market === "us" && ["growth","aggressive"].includes(profile) ? 5 : 0 };
}
export function validateAllocation(value: unknown, market: "us" | "india"): string | null {
  const p = value as AllocationPolicy;
  if (!p || p.market !== market || !ALLOCATION_PROFILES.includes(p.profile) || typeof p.enabled !== "boolean"
    || p.version !== ALLOCATION_VERSION || !Number.isInteger(p.revision) || p.revision < 0) return "Invalid allocation identity/version";
  if (!p.targets || Object.keys(p.targets).length !== ALLOCATION_BUCKETS.length
    || ALLOCATION_BUCKETS.some(key => typeof p.targets[key] !== "number" || !Number.isFinite(p.targets[key]) || p.targets[key]<0 || p.targets[key]>100)) return "Targets must be finite percentages for every bucket";
  if (Math.abs(ALLOCATION_BUCKETS.reduce((sum,key)=>sum+p.targets[key],0)-100)>0.000001) return "Allocation targets must total 100%";
  if (market === "us" && p.targets.tactical < 5) return "US tactical cash plus leveraged budget must be at least 5%";
  if (market === "india" && p.targets.oil > 0) return "No approved India oil/commodity fund is configured; energy shares belong to equities";
  if (typeof p.leveragedMaxPct !== "number" || !Number.isFinite(p.leveragedMaxPct) || p.leveragedMaxPct < 0
    || p.leveragedMaxPct > (market === "us" ? Math.min(5,p.targets.tactical) : 0)) return "Leveraged maximum is 0–5% for US and 0% for India";
  return null;
}
export type AllocationDiscoveryContext={kind:"allocation_target";profile:AllocationProfile;version:string;revision:number;bucket:AllocationBucket;target_pct:number;current_pct:number;source_as_of:string};
export const ALLOCATION_RESEARCH_FUNDS:Record<"us"|"india",Partial<Record<AllocationBucket,string[]>>>={
  us:{core_etf:["VOO","RSP"],sector_etf:["XLK","XLF"],bonds:["SHY","IEF","BND"],gold:["GLD","IAU"],silver:["SLV"],oil:["USO","PDBC"]},
  india:{core_etf:["NIFTYBEES.NS","JUNIORBEES.NS"],sector_etf:["ITBEES.NS","BANKBEES.NS"],bonds:["LIQUIDBEES.NS"],gold:["GOLDBEES.NS"],silver:["SILVERBEES.NS"]},
};
export function selectAllocationResearchSeeds(policy:AllocationPolicy,nav:number,cash:number,positions:AllocationPosition[],blocked:Set<string>,sourceAt:string,now=new Date()){
  const mix=allocationMix(policy,nav,cash,positions);
  if(!policy.enabled||mix.unknown.length||mix.rows.some(row=>row.currentPct==null))return [];
  const turn=Math.floor(now.getTime()/86400000);
  return mix.rows.filter(row=>row.targetPct>(row.currentPct??0)+0.5)
    .sort((a,b)=>(b.targetPct-(b.currentPct??0))-(a.targetPct-(a.currentPct??0)))
    .flatMap(row=>{const all=ALLOCATION_RESEARCH_FUNDS[policy.market][row.bucket]??[];
      const eligible=all.filter(symbol=>!blocked.has(symbol)&&!positions.some(p=>p.symbol.toUpperCase()===symbol));
      if(!eligible.length)return [];
      return [{symbol:eligible[turn%eligible.length],context:{kind:"allocation_target" as const,profile:policy.profile,version:policy.version,revision:policy.revision,
        bucket:row.bucket,target_pct:row.targetPct,current_pct:row.currentPct!,source_as_of:sourceAt}}];}).slice(0,2);
}
export function allocationBucket(symbol: string, market: "us" | "india", recordedAssetClass?: string | null): AllocationBucket | null {
  const s = symbol.trim().toUpperCase();
  if (!s || /-USD$/.test(s) || (market === "us" && /\.(NS|BO)$/.test(s)) || (market === "india" && !s.endsWith(".NS"))) return null;
  if (LEVERAGED_SLEEVE_SYMBOLS.has(s)) return market === "us" ? "tactical" : null;
  // Allocation-only: issuer describes JQUA as Russell-1000-sector-matched
  // diversified quality exposure, rather than a single-sector fund.
  if (market === "us" && s === "JQUA") return "core_etf";
  if (market === "us" && ["USO","UNG","PDBC","DBA"].includes(s)) return "oil";
  const p = classifyInstrumentPolicy({ symbol:s,market });
  if (p.family === "india_etf") {
    if (p.exposureId === "gold_spot_inr") return "gold";
    if (p.exposureId === "silver_spot_inr") return "silver";
    if (p.exposureId === "india_cash") return "bonds";
    if (p.exposureId.startsWith("india_index:")) return "core_etf";
    if (p.exposureId.startsWith("india_sector:")) return "sector_etf";
    return null;
  }
  if (p.family === "broad_equity_etf") return "core_etf";
  if (p.family === "fixed_income_etf") return "bonds";
  if (p.family === "gold_bullion_fund") return "gold";
  if (p.family === "silver_bullion_fund") return "silver";
  if (["sector_etf","thematic_etf","gold_miners_fund"].includes(p.family)) return "sector_etf";
  if (["unknown","crypto","leveraged_or_inverse_etf"].includes(p.family) || recordedAssetClass === "etf"
    || /BEES\.NS$/.test(s)) return null;
  return "individual";
}
export type AllocationPosition = { symbol: string; marketValue: number; assetClass?: string | null };
export function allocationBudget(policy: AllocationPolicy, symbol: string, nav: number, positions: AllocationPosition[], assetClass?: string | null) {
  const bucket = allocationBucket(symbol,policy.market,assetClass);
  if (validateAllocation(policy,policy.market) || !Number.isFinite(nav) || nav<=0 || !bucket)
    return { ok:false as const,reason:"allocation_inputs_unavailable" };
  const used = Object.fromEntries(ALLOCATION_BUCKETS.map(key=>[key,0])) as Record<AllocationBucket,number>;
  for (const p of positions) {
    const key = allocationBucket(p.symbol,policy.market,p.assetClass);
    if (!key || !Number.isFinite(p.marketValue) || p.marketValue<0) return { ok:false as const,reason:"allocation_book_unclassified_or_unpriced" };
    used[key] += p.marketValue;
  }
  const targetPct = bucket === "tactical" ? policy.leveragedMaxPct : policy.targets[bucket];
  return { ok:true as const,bucket,targetPct,used:used[bucket],remaining:policy.enabled ? Math.max(0,nav*targetPct/100-used[bucket]) : Infinity,
    version:policy.version,revision:policy.revision,profile:policy.profile };
}
export function allocationMix(policy: AllocationPolicy, nav: number, cash: number, positions: AllocationPosition[]) {
  const used = Object.fromEntries(ALLOCATION_BUCKETS.map(key=>[key,0])) as Record<AllocationBucket,number>;
  const unknown: string[]=[];
  for (const p of positions) { const bucket=allocationBucket(p.symbol,policy.market,p.assetClass);
    if (!bucket || !Number.isFinite(p.marketValue) || p.marketValue<0) unknown.push(p.symbol); else used[bucket]+=p.marketValue; }
  used.tactical+=cash;
  return { unknown,rows:ALLOCATION_BUCKETS.map(bucket=>({bucket,targetPct:policy.targets[bucket],currentPct:unknown.length || !Number.isFinite(nav) || nav<=0 || !Number.isFinite(cash) || cash<0 ? null : used[bucket]/nav*100})) };
}
export function capLeveragedPaperAllocation(policy: AllocationPolicy, symbol: string, nav: number, positions: AllocationPosition[], maxNotional: number) {
  if(!policy.enabled) return {ok:true as const,maxNotional,allocation:{enabled:false,version:policy.version,revision:policy.revision}};
  const allocation=allocationBudget(policy,symbol,nav,positions.filter(p=>LEVERAGED_SLEEVE_SYMBOLS.has(p.symbol.trim().toUpperCase())));
  if(!allocation.ok) return allocation;
  if(policy.leveragedMaxPct===0) return {ok:false as const,reason:"allocation_leveraged_disabled"};
  const size=leveragedPaperEntrySize(nav,Math.min(maxNotional,allocation.remaining));
  return size.ok ? {...size,allocation} : {...size,reason:`allocation_${size.reason}`};
}
