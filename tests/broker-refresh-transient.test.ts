import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REFRESH_IN_FLIGHT, isTransientRefreshError } from "@/lib/brokers/refresh-errors";

describe("broker token refresh: transient outcomes never raise a reconnect alert", () => {
  it("classifies only the in-flight claim as transient", () => {
    expect(isTransientRefreshError(REFRESH_IN_FLIGHT)).toBe(true);
    for (const real of ["refresh failed (417)", "no refresh token", "refresh error: Error: vault write failed", undefined, null]) {
      expect(isTransientRefreshError(real as any)).toBe(false);
    }
  });
  it("both broker drivers guard every refresh-failure alert with the transient check and use the shared constant", () => {
    for (const file of ["lib/brokers/mcp-driver.ts", "lib/robinhood-mcp.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("REFRESH_IN_FLIGHT");
      expect(src).not.toContain('"refresh in flight — retry"');
      const refreshFailureAlerts = [...src.matchAll(/Token refresh failed: \$\{r\.error\}/g)];
      expect(refreshFailureAlerts.length).toBeGreaterThanOrEqual(2);
      for (const m of refreshFailureAlerts) {
        const before = src.slice(Math.max(0, m.index! - 330), m.index!);
        expect(before).toContain("!isTransientRefreshError(r.error)");
      }
    }
  });
});
