import { describe,expect,it } from "vitest";
import { ALLOCATION_BUCKETS,ALLOCATION_PROFILES,defaultAllocation,validateAllocation,allocationBucket,allocationBudget,allocationMix,capLeveragedPaperAllocation,selectAllocationResearchSeeds } from "@/lib/allocation/profiles";
describe("market-local allocation profiles",()=>{
  it("provides independent, versioned 100% defaults for every profile/market",()=>{
    for(const market of ["us","india"] as const)for(const profile of ALLOCATION_PROFILES){const p=defaultAllocation(market,profile);
      expect(validateAllocation(p,market)).toBeNull();expect(ALLOCATION_BUCKETS.reduce((sum,k)=>sum+p.targets[k],0)).toBe(100);
      expect(p.leveragedMaxPct).toBeLessThanOrEqual(market==="us"?5:0);}
    const p=defaultAllocation("us");p.targets.gold=99;expect(defaultAllocation("us").targets.gold).toBe(5);
  });
  it("rejects invalid totals, non-finite values, extra buckets, wrong markets and leverage",()=>{
    const p=defaultAllocation("us");
    for(const change of [{targets:{...p.targets,gold:NaN}},{targets:{...p.targets,gold:6}},{targets:{...p.targets,fake:0}},
      {leveragedMaxPct:5.01},{revision:-1},{version:"unknown"},{enabled:"true"}])expect(validateAllocation({...p,...change},"us")).not.toBeNull();
    expect(validateAllocation(p,"india")).not.toBeNull();
    expect(validateAllocation({...defaultAllocation("india"),leveragedMaxPct:1},"india")).not.toBeNull();
  });
  it("distinguishes bullion, miners, energy shares, commodities and local ETFs",()=>{
    for(const [s,b]of [["GLD","gold"],["SLV","silver"],["GDX","sector_etf"],["NEM","individual"],["XLE","sector_etf"],["USO","oil"],["IEF","bonds"],["VOO","core_etf"],["SOXL","tactical"]])expect(allocationBucket(s,"us")).toBe(b);
    for(const [s,b]of [["GOLDBEES.NS","gold"],["SILVERBEES.NS","silver"],["LIQUIDBEES.NS","bonds"],["ITBEES.NS","sector_etf"],["NIFTYBEES.NS","core_etf"],["RELIANCE.NS","individual"]])expect(allocationBucket(s,"india")).toBe(b);
    expect(allocationBucket("VOO","india")).toBeNull();expect(allocationBucket("NIFTYBEES.NS","us")).toBeNull();
    expect(allocationBucket("NEWFUND","us","etf")).toBeNull();
    expect(allocationBucket("JQUA","us")).toBe("core_etf");
  });
  it("caps the aggregate bucket and refuses unknown or invalid held exposure",()=>{
    const p=defaultAllocation("us");const book=[{symbol:"AAPL",marketValue:3900}];
    expect(allocationBudget(p,"MSFT",10000,book)).toMatchObject({ok:true,remaining:100,bucket:"individual"});
    expect(allocationBudget(p,"MSFT",10000,[{symbol:"AAPL",marketValue:4500}])).toMatchObject({ok:true,remaining:0});
    expect(allocationBudget(p,"MSFT",10000,[{symbol:"NEWFUND",marketValue:100,assetClass:"etf"}]).ok).toBe(false);
    expect(allocationBudget(p,"MSFT",10000,[{symbol:"AAPL",marketValue:NaN}]).ok).toBe(false);
  });
  it("treats leveraged capital as part of tactical cash, not additive exposure",()=>{
    const p=defaultAllocation("us");const mix=allocationMix(p,10000,250,[{symbol:"SOXL",marketValue:250},{symbol:"AAPL",marketValue:9500}]);
    expect(mix.rows.find(r=>r.bucket==="tactical")?.currentPct).toBe(5);
    expect(capLeveragedPaperAllocation(p,"TQQQ",10000,[{symbol:"SOXL",marketValue:250}],500)).toMatchObject({ok:true,maxNotional:250});
    expect(capLeveragedPaperAllocation(defaultAllocation("us","balanced"),"SOXL",10000,[],500)).toMatchObject({ok:false,reason:"allocation_leveraged_disabled"});
    expect(capLeveragedPaperAllocation({...p,leveragedMaxPct:0.1},"SOXL",10000,[],500).ok).toBe(false);
  });
  it("withholds current weights for missing prices instead of treating them as zero",()=>{
    expect(allocationMix(defaultAllocation("us"),10000,100,[{symbol:"AAPL",marketValue:NaN}]).rows.every(r=>r.currentPct===null)).toBe(true);
  });
  it("admits bounded underweight research funds without overriding disabled names or buying them",()=>{
    const rows=selectAllocationResearchSeeds(defaultAllocation("us"),10000,100,[{symbol:"AAPL",marketValue:9900}],new Set(["VOO"]),"2026-10-26T20:00:00Z");
    expect(rows.length).toBeLessThanOrEqual(2);expect(rows.some(row=>row.symbol==="RSP")).toBe(true);
    expect(rows.every(row=>row.symbol!=="VOO"&&row.context.kind==="allocation_target")).toBe(true);
    const india=selectAllocationResearchSeeds(defaultAllocation("india"),10000,10000,[],new Set(),"2026-10-26T10:00:00Z");
    expect(india.every(row=>row.symbol.endsWith(".NS"))).toBe(true);
    expect(selectAllocationResearchSeeds({...defaultAllocation("us"),enabled:false},10000,10000,[],new Set(),"x")).toEqual([]);
  });
});
