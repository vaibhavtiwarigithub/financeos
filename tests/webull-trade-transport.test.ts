import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import type { WebullTradeCredential } from "@/lib/brokers/webull-trade/credentials";
import { paths } from "@/lib/brokers/webull-trade/endpoints";
import type { GateSnapshot } from "@/lib/brokers/webull-trade/gates";
import { checkWebullTokenStatus } from "@/lib/brokers/webull-trade/preflight";
import { verifySignature } from "@/lib/brokers/webull-trade/signing";
import {
  authorizeWebullOrderTransport,
  authorizeWebullPreflightTransport,
  liveWebullTransport,
} from "@/lib/brokers/webull-trade/transport";

const NOW = Date.parse("2026-07-19T12:00:00Z");
const credential: WebullTradeCredential = {
  env: "sandbox",
  appKey: "sandbox-app-key",
  appSecret: "sandbox-app-secret",
  accessToken: "sandbox-access-token",
  host: "https://api.sandbox.webull.com",
};
const prodCredential: WebullTradeCredential = {
  ...credential,
  env: "prod",
  accessToken: "prod-access-token",
  host: "https://api.webull.com",
};

function passingSnapshot(): GateSnapshot {
  return {
    globalTradingEnabled: true,
    appPaused: false,
    usMarketEnabled: true,
    usKillSwitchTripped: false,
    circuitBreakerTrippedForBuy: false,
    side: "BUY",
    autonomySatisfied: true,
    allowlistedWebullUsTradingAccounts: 1,
    orderAccountId: "605420660",
    allowlistedAccountId: "605420660",
    webullTradeOrdersEnabled: true,
    credentialPresent: true,
    token: {
      status: "NORMAL",
      lastAuthenticatedCallAt: "2026-07-19T11:59:00Z",
      serverStatusCheckedAt: "2026-07-19T11:59:00Z",
      expiresAt: "2026-08-01T00:00:00Z",
    },
    endpointExpected: true,
    timestampSkewAcceptable: true,
    riskChecksPassed: true,
    qty: 1,
    mandateMaxQty: 1,
    reconciledHeldQty: 1,
    restingExecutableSellQty: 0,
  };
}

function flagSvc(enabled: boolean = true) {
  const chain: any = {
    select() { return chain; },
    limit() { return chain; },
    async maybeSingle() { return { data: { webull_trade_orders_enabled: enabled }, error: null }; },
  };
  return { from() { return chain; } };
}

async function preflightPermit() {
  const auth = await authorizeWebullPreflightTransport(flagSvc(), "sandbox", NOW);
  if (!auth.ok) throw new Error("expected preflight permit");
  return auth.permit;
}

describe("webull_trade signed transport", () => {
  it("signs the hostname, sends the token header, and uses the exact pinned URL", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"status":"NORMAL"}', { status: 200 }));
    const transport = liveWebullTransport({
      credential,
      permit: await preflightPermit(),
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
      nonce: () => "nonce000000000001",
    });

    const result = await transport.send({ method: "POST", path: paths.tokenCheck, env: "sandbox" });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("https://api.sandbox.webull.com/openapi/auth/token/check");
    expect(headers["x-access-token"]).toBe(credential.accessToken);
    expect(headers).not.toHaveProperty("x-app-secret");
    expect(JSON.stringify({ url, headers })).not.toContain(credential.appSecret);
    expect(verifySignature({
      method: "POST",
      path: paths.tokenCheck,
      host: "api.sandbox.webull.com",
      appKey: credential.appKey,
      timestamp: headers["x-timestamp"],
      nonce: headers["x-signature-nonce"],
    }, credential.appSecret, headers["x-signature"])).toBe(true);
  });

  it("preflight cannot reach place/query/cancel and consumes no network call", async () => {
    const fetchImpl = vi.fn();
    const transport = liveWebullTransport({ credential, permit: await preflightPermit(), fetchImpl: fetchImpl as typeof fetch, now: () => NOW });
    const result = await transport.send({ method: "POST", path: paths.place, body: "{}", env: "sandbox" });
    expect(result).toEqual({
      ok: false,
      timeout: false,
      error: "webull_trade request is outside the permitted environment or capability",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cannot mint an order permit when any gate fails", () => {
    const result = authorizeWebullOrderTransport({ ...passingSnapshot(), appPaused: true }, "prod", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("global_trading_enabled");
  });

  it("a full-ladder order permit is one-shot", async () => {
    const auth = authorizeWebullOrderTransport(passingSnapshot(), "prod", NOW);
    if (!auth.ok) throw new Error("expected order permit");
    const fetchImpl = vi.fn(async () => new Response('{"order_id":"abc123"}', { status: 200 }));
    const transport = liveWebullTransport({
      credential: prodCredential,
      permit: auth.permit,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
      nonce: () => "nonce000000000002",
    });
    expect((await transport.send({ method: "POST", path: paths.place, body: "{}", env: "prod" })).ok).toBe(true);
    expect(await transport.send({ method: "POST", path: paths.place, body: "{}", env: "prod" })).toEqual({
      ok: false,
      timeout: false,
      error: "webull_trade transport permit already consumed",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("wraps HTTP, network, and timeout failures without response or credential data", async () => {
    const httpFetch = vi.fn(async () => new Response('{"message":"account 605420660 token sandbox-access-token"}', { status: 401 }));
    const httpTransport = liveWebullTransport({ credential, permit: await preflightPermit(), fetchImpl: httpFetch as typeof fetch, now: () => NOW });
    expect(await httpTransport.send({ method: "GET", path: paths.accountList, env: "sandbox" })).toEqual({
      ok: false,
      timeout: false,
      error: "webull_trade request failed with HTTP 401",
    });

    const networkFetch = vi.fn(async () => { throw new Error("sandbox-access-token sandbox-app-secret"); });
    const networkTransport = liveWebullTransport({ credential, permit: await preflightPermit(), fetchImpl: networkFetch as typeof fetch, now: () => NOW });
    expect(await networkTransport.send({ method: "GET", path: paths.accountList, env: "sandbox" })).toEqual({
      ok: false,
      timeout: false,
      error: "webull_trade network request failed",
    });

    const timeoutFetch = vi.fn(async () => { throw new DOMException("aborted", "AbortError"); });
    const timeoutTransport = liveWebullTransport({ credential, permit: await preflightPermit(), fetchImpl: timeoutFetch as typeof fetch, now: () => NOW });
    expect(await timeoutTransport.send({ method: "GET", path: paths.accountList, env: "sandbox" })).toEqual({
      ok: false,
      timeout: true,
      error: "webull_trade request timed out",
    });
  });

  it("contains the only Webull fetch implementation", () => {
    const dir = join(process.cwd(), "lib", "brokers", "webull-trade");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && name !== "transport.ts")) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, `${file} must not call fetch`).not.toMatch(/\bfetch(?:Impl)?\s*\(/);
    }
    expect(readFileSync(join(dir, "transport.ts"), "utf8").match(/await fetchImpl\s*\(/g)).toHaveLength(1);
  });
});

describe("webull_trade token preflight", () => {
  it("maps the official status and expiry to a fresh gate record", async () => {
    const transport = {
      async send() {
        return { ok: true as const, status: 200, json: { status: "NORMAL", expires: NOW + 86_400_000 } };
      },
    };
    const result = await checkWebullTokenStatus(transport, "sandbox", NOW);
    expect(result).toEqual({
      ok: true,
      token: {
        status: "NORMAL",
        expiresAt: "2026-07-20T12:00:00.000Z",
        serverStatusCheckedAt: "2026-07-19T12:00:00.000Z",
        lastAuthenticatedCallAt: "2026-07-19T12:00:00.000Z",
      },
    });
  });

  it("preserves PENDING so gate 7 can fail closed, and rejects unknown statuses", async () => {
    const pending = await checkWebullTokenStatus({
      async send() { return { ok: true as const, status: 200, json: { status: "pending" } }; },
    }, "sandbox", NOW);
    expect(pending.ok && pending.token.status).toBe("PENDING");

    const unknown = await checkWebullTokenStatus({
      async send() { return { ok: true as const, status: 200, json: { status: "SURPRISE" } }; },
    }, "sandbox", NOW);
    expect(unknown.ok).toBe(false);
  });
});
