import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Robinhood OAuth callback contract", () => {
  const login = read("app/api/robinhood-mcp/login/route.ts");
  const callback = read("app/api/robinhood-mcp/callback/route.ts");
  const client = read("lib/robinhood-mcp.ts");

  it("binds client reuse to the exact registered callback instead of a stale id", () => {
    expect(client).toContain('clientRedirects: "ROBINHOOD_MCP_CLIENT_REDIRECTS"');
    expect(client).toContain("registeredRedirects === requestedKey");
    expect(client).toContain("await vaultSet(svc, VK.clientRedirects, requestedKey)");
  });

  it("registers only the redirect URI used for authorization and exchange", () => {
    expect(login).toContain("getOrRegisterClient(svc, [redirectUri])");
    expect(login).not.toContain("http://localhost:3000/api/robinhood-mcp/callback");
  });

  it("survives a callback without the owner session by consuming single-use PKCE state", () => {
    expect(login).toContain('saveOAuthState(svc, state, verifier, redirectUri, "robinhood")');
    expect(callback).toContain('consumeOAuthState(svc, state, "robinhood")');
    expect(callback).not.toContain("requireOwner");
    expect(callback).toContain("savedRedirectUri !== redirectUri");
  });
});
