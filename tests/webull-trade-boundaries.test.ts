// webull_trade — transport/market/secret boundaries.
// Covers Failure Tests 1 (Cloud MCP has no write scope or order tool),
// 7 (secret capture across logs/errors/traces), 12 (India unreachable),
// and the "no second Webull order adapter" invariant.
import { describe, it, expect, vi, afterEach } from "vitest";
import { getMcpBroker, MCP_BROKERS } from "@/lib/brokers/mcp-registry";
import { getBroker, listBrokers } from "@/lib/brokers/registry";
import { webullTradeAdapter } from "@/lib/brokers/webull-trade/adapter";
import { signRequest, buildCanonicalRequest, buildSignatureHeaders } from "@/lib/brokers/webull-trade/signing";
import { getWebullTradeCredential, clearCredentialCache, hostForEnv } from "@/lib/brokers/webull-trade/credentials";
import { placeOrder } from "@/lib/brokers/webull-trade/lifecycle";
import { normalizeOrder } from "@/lib/brokers/webull-trade/order";
import type { WebullTransport } from "@/lib/brokers/webull-trade/transport";
import type { WebullNormalizedOrder } from "@/lib/brokers/webull-trade/types";

describe("Test 1 — Cloud MCP stays query-only and order-inert", () => {
  it("the webull MCP config declares no order tools, no order scopes, and is not orderCapable", () => {
    const cfg = getMcpBroker("webull");
    expect(cfg).toBeDefined();
    expect(cfg!.orderCapable).not.toBe(true);
    expect(cfg!.orderTools).toBeUndefined();
    expect(cfg!.orderScopes).toBeUndefined();
  });

  it("the MCP read scopes contain no write/order/trade permission", () => {
    const scopes = getMcpBroker("webull")!.oauth.scopes.toLowerCase();
    for (const forbidden of ["write", "order", "trade", "place", "cancel"]) {
      expect(scopes, `MCP scopes must not contain '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it("NO broker in the read-only MCP registry is order-capable", () => {
    for (const [id, cfg] of Object.entries(MCP_BROKERS)) {
      expect(cfg.orderCapable, `${id} must not be orderCapable`).not.toBe(true);
      expect(cfg.orderTools, `${id} must declare no order tools`).toBeUndefined();
    }
  });
});

describe("no second Webull order adapter", () => {
  it("the order registry exposes webull_trade and NOT the retired `webull` order adapter", () => {
    expect(getBroker("webull_trade")).not.toBeNull();
    expect(getBroker("webull")).toBeNull(); // the inert MCP order scaffold is gone
  });

  it("signed execution id is exactly `webull_trade`", () => {
    expect(webullTradeAdapter().id).toBe("webull_trade");
  });
});

describe("Test 12 — India state is unreachable from this US adapter", () => {
  it("the adapter is US-only", () => {
    expect(webullTradeAdapter().market).toBe("us");
  });

  it("webull_trade never appears in the India broker list", () => {
    expect(listBrokers("india").map(b => b.id)).not.toContain("webull_trade");
    expect(listBrokers("us").map(b => b.id)).toContain("webull_trade");
  });

  it("the normalized order shape carries no market/currency field an India path could set", () => {
    const r = normalizeOrder({ accountId: "WBACCT1", symbol: "AAPL", side: "BUY", orderType: "MARKET", qty: 1, clientOrderId: "kai0abc" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order).not.toHaveProperty("market");
      expect(r.order).not.toHaveProperty("currency");
      // Session vocabulary is US-equity only; no NSE/BSE concept exists here.
      expect(r.order.session).toBe("CORE");
    }
  });

  it("an India-flavoured symbol is not special-cased — it carries no India state", () => {
    const r = normalizeOrder({ accountId: "WBACCT1", symbol: "RELIANCE.NS", side: "BUY", orderType: "MARKET", qty: 1, clientOrderId: "kai0abc" });
    // The adapter has no India routing; the account allowlist (US-only) is the gate.
    if (r.ok) expect(r.order).not.toHaveProperty("market");
  });
});

describe("Test 7 — secret capture: logs, errors, traces never carry sensitive material", () => {
  const SECRET = "SUPER-SECRET-app-secret";
  const ACCOUNT = "WBACCT-PRIVATE-1";
  const TOKEN = "tok-abcdef-private";

  afterEach(() => { vi.restoreAllMocks(); clearCredentialCache(); });

  function captureConsole() {
    const lines: string[] = [];
    const sink = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    vi.spyOn(console, "log").mockImplementation(sink);
    vi.spyOn(console, "error").mockImplementation(sink);
    vi.spyOn(console, "warn").mockImplementation(sink);
    vi.spyOn(console, "info").mockImplementation(sink);
    vi.spyOn(console, "debug").mockImplementation(sink);
    return lines;
  }

  it("signing emits nothing to the console and the signature/headers never contain the secret", () => {
    const lines = captureConsole();
    const req = {
      method: "POST", path: "/trade/v1/order/place",
      host: "api.webull.com",
      body: JSON.stringify({ account_id: ACCOUNT }),
      appKey: "k", nonce: "n", timestamp: "1752800000000",
    };
    const sig = signRequest(req, SECRET);
    const headers = buildSignatureHeaders(req, SECRET);
    expect(lines.join("\n")).toBe("");
    expect(sig).not.toContain(SECRET);
    expect(JSON.stringify(headers)).not.toContain(SECRET);
    // Headers must not smuggle the canonical request (which contains the account id).
    expect(JSON.stringify(headers)).not.toContain(ACCOUNT);
  });

  it("the canonical request is never emitted by the signing module itself", () => {
    const lines = captureConsole();
    const canonical = buildCanonicalRequest({
      method: "POST", path: "/p", body: JSON.stringify({ account_id: ACCOUNT }),
      host: "api.webull.com",
      appKey: "k", nonce: "n", timestamp: "1",
    });
    // The canonical request legitimately contains the account id — which is exactly
    // why it must never be logged or crossed to telemetry.
    expect(canonical).not.toContain(ACCOUNT);
    expect(lines.join("\n")).not.toContain(ACCOUNT);
  });

  it("a missing-credential error names neither the secret nor the token", async () => {
    const lines = captureConsole();
    const reader = { async readKey() { return null; } };
    const r = await getWebullTradeCredential(reader, "prod");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(SECRET);
      expect(r.error).not.toContain(TOKEN);
      expect(r.error).not.toContain(ACCOUNT);
    }
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("a failed place surfaces an error carrying no secret, token, signature, or canonical request", async () => {
    const lines = captureConsole();
    const order: WebullNormalizedOrder = {
      accountId: ACCOUNT, symbol: "AAPL", side: "BUY", orderType: "MARKET",
      qty: 1, timeInForce: "DAY", session: "CORE", clientOrderId: "kai0abc",
    };
    const transport: WebullTransport = { async send() { return { ok: false, timeout: true, error: "request timed out" }; } };
    const r = await placeOrder(transport, order, "prod");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      for (const sensitive of [SECRET, TOKEN, ACCOUNT]) {
        expect(r.error, `error must not contain ${sensitive}`).not.toContain(sensitive);
      }
    }
    expect(lines.join("\n")).toBe("");
  });

  it("the live transport's generic error text leaks no request internals", async () => {
    // The sole Webull fetch is isolated here; errors are fixed strings and never
    // interpolate the URL, headers, signature, body, or broker response.
    const src = await import("fs").then(fs =>
      fs.readFileSync("lib/brokers/webull-trade/transport.ts", "utf8"));
    expect(src.match(/await fetchImpl\s*\(/g)).toHaveLength(1);
    expect(src).toContain("webull_trade network request failed");
    // No console.* call anywhere in the signed transport/signing/credentials path.
    for (const f of ["transport.ts", "signing.ts", "credentials.ts", "lifecycle.ts"]) {
      const s = await import("fs").then(fs => fs.readFileSync(`lib/brokers/webull-trade/${f}`, "utf8"));
      const code = s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, `${f} must not log`).not.toMatch(/console\.(log|error|warn|info|debug)/);
    }
  });

  it("sandbox and prod hosts are distinct constants, so an env mixup is detectable", () => {
    expect(hostForEnv("sandbox")).not.toBe(hostForEnv("prod"));
  });
});
