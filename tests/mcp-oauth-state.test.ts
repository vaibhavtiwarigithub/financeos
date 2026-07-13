import { describe, expect, it } from "vitest";
import { consumeOAuthState } from "@/lib/brokers/mcp-driver";

function stateSvc(row: any) {
  const calls: any[] = [];
  const builder: any = {
    delete: () => builder,
    eq: (key: string, value: string) => {
      calls.push([key, value]);
      return builder;
    },
    select: () => builder,
    maybeSingle: async () => ({ data: row }),
  };
  return { calls, svc: { from: () => builder } };
}

describe("consumeOAuthState", () => {
  it("claims state atomically by deleting the provider-scoped row before returning verifier", async () => {
    const { svc, calls } = stateSvc({
      verifier: "verifier-1",
      redirect_uri: "https://app.example/api/webull/callback",
      provider: "webull",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(consumeOAuthState(svc, "state-1", "webull")).resolves.toEqual({
      verifier: "verifier-1",
      redirectUri: "https://app.example/api/webull/callback",
    });
    expect(calls).toEqual([
      ["state", "state-1"],
      ["provider", "webull"],
    ]);
  });

  it("rejects expired states after consuming them", async () => {
    const { svc } = stateSvc({
      verifier: "verifier-1",
      redirect_uri: null,
      provider: "webull",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await expect(consumeOAuthState(svc, "state-1", "webull")).resolves.toBeNull();
  });
});
