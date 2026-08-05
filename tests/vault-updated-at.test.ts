import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// api_key_vault.updated_at only ever moved on the compare-and-swap claim inside
// refreshAccessToken. vaultSet never stamped it, so ACCESS_TOKEN and
// TOKEN_EXPIRY kept the timestamp of their first insert regardless of how often
// the value changed: a successful re-auth on 2026-08-05 left both rows reading
// 2026-07-07, and the freshness question had a confidently wrong answer.
describe("vault writes stamp updated_at", () => {
  for (const p of ["lib/robinhood-mcp.ts", "lib/brokers/mcp-driver.ts"]) {
    it(`${p} stamps updated_at on vaultSet`, () => {
      const src = read(p);
      const set = src.slice(src.indexOf("async function vaultSet"));
      const body = set.slice(0, set.indexOf("\n}\n"));
      expect(body).toContain("updated_at: new Date().toISOString()");
    });
  }

  it("keeps the CAS claim intact — it owns concurrency, not display", () => {
    // The claim reads updated_at, then updates only if it is unchanged. That is
    // what makes concurrent refreshes safe; stamping in vaultSet happens after a
    // claim has already succeeded and must not replace it.
    const src = read("lib/robinhood-mcp.ts");
    expect(src).toContain('.eq("updated_at", updatedAt)');
    expect(src).toContain('.update({ updated_at: nowIso })');
    expect(src).toContain("refresh in flight — retry");
  });
});
