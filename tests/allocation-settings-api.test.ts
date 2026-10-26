import {beforeEach,describe,expect,it,vi} from "vitest";
import {NextRequest,NextResponse} from "next/server";
const mocks=vi.hoisted(()=>({owner:vi.fn(),svc:vi.fn(),save:vi.fn(),load:vi.fn()}));
vi.mock("@/lib/auth/require-owner",()=>({requireOwner:mocks.owner}));
vi.mock("@/lib/supabase/service",()=>({createServiceClient:mocks.svc}));
vi.mock("@/lib/allocation/profile-store",()=>({savePaperAllocation:mocks.save,loadPaperAllocation:mocks.load}));
import {PATCH,GET} from "@/app/api/settings/risk-profile/route";
const request=(body:unknown)=>new NextRequest("https://example.test/api/settings/risk-profile",{method:"PATCH",body:JSON.stringify(body),headers:{"Content-Type":"application/json"}});
describe("owner allocation API boundary",()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.owner.mockResolvedValue(null);mocks.svc.mockReturnValue({});});
  it("rejects unauthorized reads and writes before accessing storage",async()=>{
    mocks.owner.mockResolvedValue(NextResponse.json({error:"Forbidden"},{status:403}));
    expect((await PATCH(request({action:"allocation_policy"}))).status).toBe(403);
    const response=await GET(new NextRequest("https://example.test/api/settings/risk-profile?section=allocation&market=us"));
    expect(response.status).toBe(403);
    expect(mocks.svc).not.toHaveBeenCalled();expect(mocks.save).not.toHaveBeenCalled();
  });
  it("refuses mixed broker mutations and malformed payloads",async()=>{
    expect((await PATCH(request({action:"allocation_policy",trading_enabled_us:true}))).status).toBe(400);
    expect((await PATCH(request(null))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("returns revision conflicts without touching legacy trading controls",async()=>{
    mocks.save.mockResolvedValue({status:409,error:"Allocation changed; reload before saving"});
    expect((await PATCH(request({action:"allocation_policy",market:"us",reset:true}))).status).toBe(409);
    expect(mocks.save).toHaveBeenCalledOnce();
  });
});
