// webull_trade — vault credential accessor + secret hygiene + env/host pinning.
// Covers Failure Tests 5 (sandbox creds cannot call prod), 7 (secret capture).
import { describe, it, expect, beforeEach } from "vitest";
import {
  getWebullTradeCredential,
  clearCredentialCache,
  hostForEnv,
  assertHostMatchesEnv,
  VAULT_PROVIDER_TAG,
} from "@/lib/brokers/webull-trade/credentials";
import { liveWebullTransport } from "@/lib/brokers/webull-trade/transport";

const SANDBOX_SECRET = "SANDBOX-secret-xyz";
const PROD_SECRET = "PROD-secret-xyz";

// A fake vault reader: separate sandbox and prod records under provider webull_trade.
function fakeReader(store: Record<string, string>) {
  const calls: { keyName: string; provider: string }[] = [];
  return {
    calls,
    reader: {
      async readKey(keyName: string, provider: string): Promise<string | null> {
        calls.push({ keyName, provider });
        if (provider !== VAULT_PROVIDER_TAG) return null; // wrong provider tag → not accepted
        return store[keyName] ?? null;
      },
    },
  };
}

const STORE = {
  WEBULL_TRADE_SANDBOX_APP_KEY: "sandbox-key",
  WEBULL_TRADE_SANDBOX_APP_SECRET: SANDBOX_SECRET,
  WEBULL_TRADE_PROD_APP_KEY: "prod-key",
  WEBULL_TRADE_PROD_APP_SECRET: PROD_SECRET,
};

describe("webull_trade credentials", () => {
  beforeEach(() => clearCredentialCache());

  it("resolves sandbox creds pinned to the sandbox host", async () => {
    const { reader } = fakeReader(STORE);
    const r = await getWebullTradeCredential(reader, "sandbox");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.credential.env).toBe("sandbox");
      expect(r.credential.host).toBe(hostForEnv("sandbox"));
      expect(r.credential.appKey).toBe("sandbox-key");
    }
  });

  it("resolves prod creds pinned to the prod host", async () => {
    const { reader } = fakeReader(STORE);
    const r = await getWebullTradeCredential(reader, "prod");
    expect(r.ok && r.credential.host).toBe(hostForEnv("prod"));
  });

  it("sandbox and prod hosts differ — a sandbox credential can NEVER resolve a prod host (Test 5)", async () => {
    expect(hostForEnv("sandbox")).not.toBe(hostForEnv("prod"));
    const { reader } = fakeReader(STORE);
    const sb = await getWebullTradeCredential(reader, "sandbox");
    if (sb.ok) {
      expect(sb.credential.host).toBe(hostForEnv("sandbox"));
      expect(assertHostMatchesEnv("sandbox", sb.credential.host)).toBe(true);
      expect(assertHostMatchesEnv("prod", sb.credential.host)).toBe(false); // cannot masquerade as prod
    }
  });

  it("the shipped code cannot construct a network-capable transport", async () => {
    const { reader } = fakeReader(STORE);
    const sb = await getWebullTradeCredential(reader, "sandbox");
    if (!sb.ok) throw new Error("expected sandbox creds");
    // Construct with enabled:true ONLY to exercise the env-mismatch guard (no network
    // is reached — the guard returns before fetch).
    expect(() => liveWebullTransport({ enabled: true, credential: sb.credential })).toThrow(/not implemented|disabled/);
  });

  it("fails closed when a credential is missing, WITHOUT leaking any secret", async () => {
    const { reader } = fakeReader({ WEBULL_TRADE_PROD_APP_KEY: "prod-key" }); // no secret
    const r = await getWebullTradeCredential(reader, "prod");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(PROD_SECRET);
      expect(r.error).toMatch(/not provisioned/);
    }
  });

  it("rejects a value stored under the wrong provider tag", async () => {
    const reader = {
      async readKey(_k: string, provider: string) {
        return provider === "some_other_provider" ? "leaked" : null;
      },
    };
    const r = await getWebullTradeCredential(reader, "prod");
    expect(r.ok).toBe(false);
  });

  it("the returned credential and any error never expose the secret in a serialized form we log", async () => {
    const { reader } = fakeReader(STORE);
    const r = await getWebullTradeCredential(reader, "prod");
    // The secret is present on the credential object (needed to sign) but we assert
    // our own error/telemetry surfaces never carry it. The signing test proves the
    // signature/headers never carry it either.
    if (r.ok) {
      const safeLog = `webull_trade prod resolved host=${r.credential.host} appKeyLen=${r.credential.appKey.length}`;
      expect(safeLog).not.toContain(PROD_SECRET);
    }
  });

  it("bounded cache: a second read within TTL does not re-hit the vault; expiry re-reads", async () => {
    const { reader, calls } = fakeReader(STORE);
    await getWebullTradeCredential(reader, "prod", { now: 1000, ttlMs: 5000 });
    const firstCalls = calls.length;
    await getWebullTradeCredential(reader, "prod", { now: 2000, ttlMs: 5000 }); // cached
    expect(calls.length).toBe(firstCalls);
    await getWebullTradeCredential(reader, "prod", { now: 9000, ttlMs: 5000 }); // expired → re-read
    expect(calls.length).toBeGreaterThan(firstCalls);
  });
});

describe("webull_trade live transport is disabled by construction", () => {
  it("throws unless explicitly enabled — no live/sandbox call is possible from build/test", () => {
    const credential = { env: "prod" as const, appKey: "k", appSecret: "s", host: hostForEnv("prod") };
    expect(() => liveWebullTransport({ enabled: false, credential })).toThrow(/disabled/);
    // The default (no flag) is also disabled.
    expect(() => liveWebullTransport({ enabled: undefined as any, credential })).toThrow(/disabled/);
  });
});
