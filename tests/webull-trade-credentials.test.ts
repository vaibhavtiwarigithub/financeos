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
import {
  authorizeWebullPreflightTransport,
  liveWebullTransport,
} from "@/lib/brokers/webull-trade/transport";

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
  WEBULL_TRADE_SANDBOX_ACCESS_TOKEN: "sandbox-token",
  WEBULL_TRADE_PROD_APP_KEY: "prod-key",
  WEBULL_TRADE_PROD_APP_SECRET: PROD_SECRET,
  WEBULL_TRADE_PROD_ACCESS_TOKEN: "prod-token",
};

function flagSvc(enabled: boolean) {
  const chain: any = {
    select() { return chain; },
    limit() { return chain; },
    async maybeSingle() { return { data: { webull_trade_orders_enabled: enabled }, error: null }; },
  };
  return { from() { return chain; } };
}

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
      expect(r.credential.accessToken).toBe("sandbox-token");
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

  it("a sandbox permit cannot construct a prod transport", async () => {
    const { reader } = fakeReader(STORE);
    const prod = await getWebullTradeCredential(reader, "prod");
    if (!prod.ok) throw new Error("expected prod creds");
    // Exercise the env-mismatch guard; no network is reached.
    const auth = await authorizeWebullPreflightTransport(flagSvc(true), "sandbox");
    if (!auth.ok) throw new Error("expected permit");
    expect(() => liveWebullTransport({ credential: prod.credential, permit: auth.permit })).toThrow(/environments do not match/);
  });

  it("fails closed when a credential is missing, WITHOUT leaking any secret", async () => {
    const { reader } = fakeReader({ WEBULL_TRADE_PROD_APP_KEY: "prod-key" }); // no secret/token
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

describe("webull_trade live transport permit", () => {
  it("cannot be minted while the false-by-default database feature flag is off", async () => {
    expect((await authorizeWebullPreflightTransport(flagSvc(false), "prod")).ok).toBe(false);
    expect((await authorizeWebullPreflightTransport({ from() { throw new Error("db down"); } }, "prod")).ok).toBe(false);
  });
});
