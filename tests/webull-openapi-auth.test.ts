import { describe, expect, it, vi } from "vitest";
import { callWebullTokenApi } from "@/lib/data/webull-openapi-auth";

const credentials = { appKey: "app-key", appSecret: "app-secret", accessToken: null };
const issuedToken = "ccb071f764864b65a1fb48484e940a56";

describe("Webull OpenAPI token lifecycle client", () => {
  it("requests a signed production verification token without returning provider error bodies", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      url = String(input); init = options;
      return new Response(JSON.stringify({ token: issuedToken, expires_at: 1792450000000, status: "PENDING" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await callWebullTokenApi("create", credentials, { fetcher, now: () => Date.parse("2026-10-19T15:00:00Z") });
    expect(url).toBe("https://api.webull.com/auth/tokens/create");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("");
    expect(new Headers(init?.headers).get("x-version")).toBe("v3");
    expect(new Headers(init?.headers).get("x-access-token")).toBeNull();
    expect(result).toEqual({ state: "token_status", httpStatus: 200, status: "PENDING", token: issuedToken, expiresAt: 1792450000000 });
  });

  it("checks token status using the access-token header and never includes the token in its result", async () => {
    let init: RequestInit | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
      init = options;
      return new Response(JSON.stringify({ status: "NORMAL" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await callWebullTokenApi("check", { ...credentials, accessToken: issuedToken }, { fetcher });
    expect(new Headers(init?.headers).get("x-access-token")).toBe(issuedToken);
    expect(result).toEqual({ state: "token_status", httpStatus: 200, status: "NORMAL" });
    expect(JSON.stringify(result)).not.toContain(issuedToken);
  });

  it("fails closed when checking without a token, and rejects malformed create responses", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await callWebullTokenApi("check", credentials, { fetcher })).toEqual({ state: "token_required" });
    const malformed = vi.fn(async () => new Response(JSON.stringify({ token: "not-a-token", status: "PENDING" }), { status: 200 })) as unknown as typeof fetch;
    expect(await callWebullTokenApi("create", credentials, { fetcher: malformed })).toEqual({ state: "schema_invalid", httpStatus: 200 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[401, "authentication_failed"], [429, "rate_limited"], [403, "provider_error"]] as const)("redacts HTTP %s token errors", async (status, detail) => {
    const fetcher = vi.fn(async () => new Response("raw provider detail must stay server-side", { status })) as unknown as typeof fetch;
    const result = await callWebullTokenApi("create", credentials, { fetcher });
    expect(result).toEqual({ state: "http_rejected", httpStatus: status, detail });
    expect(JSON.stringify(result)).not.toContain("raw provider detail");
  });
});
