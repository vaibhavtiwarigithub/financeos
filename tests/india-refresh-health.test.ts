import {beforeEach,describe,expect,it,vi} from "vitest";
import {NextRequest} from "next/server";
const mock=vi.hoisted(()=>({resolve:vi.fn(),overview:vi.fn(),candles:vi.fn(),upsert:vi.fn()}));
vi.mock("@/lib/auth/cron",()=>({verifyCronSecret:()=>true}));
vi.mock("@/lib/nse-data",()=>({fetchNseEquityList:async()=>["TEST.NS"]}));
vi.mock("@/lib/nifty50-constituents",()=>({fetchNifty50Constituents:async()=>["TEST.NS"]}));
vi.mock("@/lib/india-universe",()=>({NIFTY_50:["TEST.NS"],indiaScreenUniverse:()=>["TEST.NS"],orderUniverseForRefresh:(x:any)=>x,buildIndiaRefreshSlice:()=>["TEST.NS"]}));
vi.mock("@/lib/data/upstox-bulk",()=>({fetchUpstoxBulkQuotes:async()=>new Map(),applyPrefilter:vi.fn()}));
vi.mock("@/lib/india-data",()=>({fetchIndiaOverview:mock.overview,fetchYahooCandles:mock.candles}));
vi.mock("@/lib/data/technicals",()=>({computeTechnicals:()=>({rsi14:60,ema50:95,priceVsEma50:"above"})}));
vi.mock("@/lib/system-health",()=>({reportIssue:vi.fn(),resolveIssue:mock.resolve}));
vi.mock("@/lib/supabase/service",()=>({createServiceClient:()=>({from:()=>({select:async()=>({data:[]}),upsert:mock.upsert})})}));
import {POST} from "@/app/api/scan/india/refresh/route";
const key="india-screen-cache:no-fresh-candidates";
describe("India screen producer health recovery",()=>{
  beforeEach(()=>{vi.clearAllMocks();mock.overview.mockResolvedValue({Name:"TEST"});mock.candles.mockResolvedValue([{close:100}]);mock.upsert.mockResolvedValue({error:null});});
  it("clears stale consumer health only after a verified fresh publication",async()=>{
    const r=await POST(new NextRequest("https://example.test/api/scan/india/refresh",{method:"POST"}));
    expect((await r.json()).scored).toBe(1);
    expect(mock.resolve).toHaveBeenCalledWith(key,expect.anything());
    expect(mock.upsert.mock.invocationCallOrder[0]).toBeLessThan(mock.resolve.mock.invocationCallOrder.at(-1)!);
  });
  it("retains the alert when every persistence attempt fails",async()=>{
    mock.upsert.mockResolvedValue({error:{message:"offline"}});
    const r=await POST(new NextRequest("https://example.test/api/scan/india/refresh",{method:"POST"}));
    expect((await r.json()).scored).toBe(0);
    expect(mock.resolve.mock.calls.some(([k])=>k===key)).toBe(false);
  });
  it("retains the alert when no usable observations were collected",async()=>{
    mock.overview.mockResolvedValue(null);mock.candles.mockResolvedValue([]);
    const r=await POST(new NextRequest("https://example.test/api/scan/india/refresh",{method:"POST"}));
    expect((await r.json()).scored).toBe(0);expect(mock.upsert).not.toHaveBeenCalled();
    expect(mock.resolve.mock.calls.some(([k])=>k===key)).toBe(false);
  });
});
