import { describe, expect, it, vi } from "vitest";
import { normalizeWebullCredential, runWebullOpenApiPreflight } from "@/lib/data/webull-openapi-preflight";

const credentials = { appKey: "app-key", appSecret: "app-secret", accessToken: "access-token" };

describe("Webull OpenAPI read-only preflight", () => {
  it("normalizes accidental outer ASCII and smart quote wrappers only", () => {
    expect(normalizeWebullCredential("  “app-key” ")).toBe("app-key");
    expect(normalizeWebullCredential("‘app-secret’")).toBe("app-secret");
    expect(normalizeWebullCredential("  app-key  ")).toBe("app-key");
    expect(normalizeWebullCredential("  ")).toBeNull();
  });

  it("does not call Webull without app credentials or the previously required access token", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await runWebullOpenApiPreflight({ ...credentials, appKey: null }, { fetcher })).toEqual({ state: "credentials_missing", detail: "app_key_missing" });
    expect(await runWebullOpenApiPreflight({ ...credentials, accessToken: null }, { fetcher })).toEqual({ state: "access_token_required", detail: "access_token_missing" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends only the fixed, signed v3 AAPL snapshot read and validates its response shape", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify([{ symbol: "AAPL", price: "250.12", last_trade_time: 1792440000000 }]), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWebullOpenApiPreflight(credentials, { fetcher, now: () => Date.parse("2026-10-19T15:00:00Z") });
    expect(result).toMatchObject({ state: "snapshot_contract_valid", httpStatus: 200, symbol: "AAPL", hasPrice: true });
    expect(capturedUrl).toContain("/market-data/stocks/snapshots/list?");
    expect(capturedUrl).toContain("symbols=AAPL");
    expect(capturedUrl).toContain("category=US_STOCK");
    expect(capturedUrl).not.toContain("order");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-version")).toBe("v3");
    expect(headers.get("x-app-key")).toBe("app-key");
    expect(headers.get("x-access-token")).toBe("access-token");
    expect(headers.get("x-signature")).toBeTruthy();
    expect(JSON.stringify(capturedInit)).not.toContain("app-secret");
  });

  it.each([
    [401, "authentication_failed"],
    [403, "entitlement_or_scope_denied"],
    [429, "rate_limited"],
  ] as const)("maps HTTP %s to a redacted diagnostic", async (status, detail) => {
    const fetcher = vi.fn(async () => new Response("sensitive provider body must not escape", { status })) as unknown as typeof fetch;
    const result = await runWebullOpenApiPreflight(credentials, { fetcher });
    expect(result).toEqual({ state: "http_rejected", httpStatus: status, detail });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("fails closed on malformed or incomplete snapshot payloads", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify([{ symbol: "AAPL", price: "NaN" }]), { status: 200 })) as unknown as typeof fetch;
    expect(await runWebullOpenApiPreflight(credentials, { fetcher })).toEqual({ state: "schema_invalid", httpStatus: 200 });
  });
});
