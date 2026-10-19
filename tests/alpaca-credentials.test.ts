import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: new Map<string, string>() }));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, keyName: string) => ({
          maybeSingle: async () => ({ data: h.rows.has(keyName) ? { key_value: h.rows.get(keyName) } : null }),
        }),
      }),
    }),
  }),
}));

import { getAlpacaCredentials, isAlpacaConfigured } from "@/lib/brokers/alpaca-credentials";

const ENV_NAMES = [
  "ALPACA_PAPER_API_KEY", "ALPACA_PAPER_API_SECRET", "ALPACA_LIVE_API_KEY", "ALPACA_LIVE_API_SECRET",
  "ALPACA_API_KEY", "ALPACA_API_SECRET",
] as const;
let oldEnv: Partial<Record<typeof ENV_NAMES[number], string | undefined>>;

describe("Alpaca credential resolution", () => {
  beforeEach(() => {
    oldEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
    for (const name of ENV_NAMES) delete process.env[name];
    h.rows.clear();
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const previous = oldEnv[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("resolves a complete paper pair from environment variables", async () => {
    process.env.ALPACA_PAPER_API_KEY = "paper-key";
    process.env.ALPACA_PAPER_API_SECRET = "paper-secret";
    await expect(getAlpacaCredentials("paper")).resolves.toEqual({ key: "paper-key", secret: "paper-secret" });
  });

  it("refuses a partial pair and does not report the broker configured", async () => {
    process.env.ALPACA_PAPER_API_KEY = "paper-key";
    await expect(getAlpacaCredentials("paper")).resolves.toBeNull();
    await expect(isAlpacaConfigured()).resolves.toBe(false);
  });

  it("prefers non-empty Vault values and falls back per field when a Vault row is blank", async () => {
    process.env.ALPACA_PAPER_API_KEY = "env-key";
    process.env.ALPACA_PAPER_API_SECRET = "env-secret";
    h.rows.set("ALPACA_PAPER_API_KEY", "vault-key");
    h.rows.set("ALPACA_PAPER_API_SECRET", "   ");
    await expect(getAlpacaCredentials("paper")).resolves.toEqual({ key: "vault-key", secret: "env-secret" });
  });

  it("recognizes either complete paper or live credentials, never a lone key", async () => {
    h.rows.set("ALPACA_API_KEY", "live-key");
    await expect(isAlpacaConfigured()).resolves.toBe(false);
    h.rows.set("ALPACA_API_SECRET", "live-secret");
    await expect(isAlpacaConfigured()).resolves.toBe(true);
  });

  it("recognizes the explicit live environment pair without reading paper credentials", async () => {
    process.env.ALPACA_LIVE_API_KEY = "live-key";
    process.env.ALPACA_LIVE_API_SECRET = "live-secret";
    process.env.ALPACA_PAPER_API_KEY = "paper-key";
    process.env.ALPACA_PAPER_API_SECRET = "paper-secret";
    await expect(getAlpacaCredentials("live")).resolves.toEqual({ key: "live-key", secret: "live-secret" });
    await expect(getAlpacaCredentials("paper")).resolves.toEqual({ key: "paper-key", secret: "paper-secret" });
  });

  it("prefers canonical live Vault rows and retains legacy live aliases", async () => {
    process.env.ALPACA_LIVE_API_KEY = "env-key";
    process.env.ALPACA_LIVE_API_SECRET = "env-secret";
    h.rows.set("ALPACA_LIVE_API_KEY", "vault-live-key");
    h.rows.set("ALPACA_LIVE_API_SECRET", "vault-live-secret");
    await expect(getAlpacaCredentials("live")).resolves.toEqual({ key: "vault-live-key", secret: "vault-live-secret" });

    h.rows.clear();
    delete process.env.ALPACA_LIVE_API_KEY;
    delete process.env.ALPACA_LIVE_API_SECRET;
    process.env.ALPACA_API_KEY = "legacy-key";
    process.env.ALPACA_API_SECRET = "legacy-secret";
    await expect(getAlpacaCredentials("live")).resolves.toEqual({ key: "legacy-key", secret: "legacy-secret" });
  });

  it("does not use live credentials to complete an incomplete paper pair", async () => {
    process.env.ALPACA_LIVE_API_KEY = "live-key";
    process.env.ALPACA_LIVE_API_SECRET = "live-secret";
    process.env.ALPACA_PAPER_API_KEY = "paper-key";
    await expect(getAlpacaCredentials("paper")).resolves.toBeNull();
  });
});
