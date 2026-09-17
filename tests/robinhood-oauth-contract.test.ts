import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Robinhood OAuth containment contract", () => {
  const login = read("app/api/robinhood-mcp/login/route.ts");
  const callback = read("app/api/robinhood-mcp/callback/route.ts");
  const client = read("lib/robinhood-mcp.ts");

  it("keeps the legacy client helper bound to an exact callback if it is ever reintroduced", () => {
    expect(client).toContain('clientRedirects: "ROBINHOOD_MCP_CLIENT_REDIRECTS"');
    expect(client).toContain("registeredRedirects === requestedKey");
    expect(client).toContain("await vaultSet(svc, VK.clientRedirects, requestedKey)");
  });

  it("does not send the owner through Robinhood's broken bespoke consent flow", () => {
    expect(login).not.toContain("getOrRegisterClient(");
    expect(login).not.toContain("buildAuthUrl(");
    expect(login).toContain("rhmcp=platform_connect_required");
  });

  it("keeps a pending legacy callback fail-closed with single-use state validation", () => {
    expect(callback).toContain('consumeOAuthState(svc, state, "robinhood")');
    expect(callback).not.toContain("requireOwner");
    expect(callback).toContain("savedRedirectUri !== redirectUri");
  });
});
