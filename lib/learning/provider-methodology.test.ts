import {describe,expect,it,vi} from "vitest";
import {readProviderMethodology} from "./provider-methodology";

describe("bounded provider methodology research",()=>{
  it("refuses arbitrary URLs without making any network request",async()=>{
    const fetcher=vi.fn();
    expect((await readProviderMethodology("http://localhost/secrets",fetcher as any)).status).toBe("unsupported_provider");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses a fixed public URL, refuses redirects and strips scripts from cited text",async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response('<html><script>run(secret)</script><p>Vintage data</p></html>',{headers:{"content-type":"text/html"}}));
    const result=await readProviderMethodology("fred",fetcher);
    expect(fetcher).toHaveBeenCalledWith("https://fred.stlouisfed.org/docs/api/fred/alfred.html",expect.objectContaining({redirect:"error"}));
    expect(result.status).toBe("fetched");
    expect(result.excerpt).toBe("Vintage data");expect(result.sha256).toHaveLength(64);
  });
  it("keeps denied, oversized and binary documentation unavailable",async()=>{
    for(const response of [new Response("denied",{status:403}),new Response("binary",{headers:{"content-type":"application/pdf"}})]) {
      expect((await readProviderMethodology("sec",vi.fn().mockResolvedValue(response))).status).toBe("documentation_unavailable");
    }
    expect((await readProviderMethodology("fred",vi.fn().mockResolvedValue(new Response("x".repeat(65537),{headers:{"content-type":"text/html"}})))).status).toBe("document_exceeds_budget");
  });
});
