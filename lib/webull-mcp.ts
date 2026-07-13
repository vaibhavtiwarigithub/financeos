import { createServiceClient } from "@/lib/supabase/service";
import { randomBytes } from "crypto";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import type { BrokerAccount, BrokerHolding } from "@/lib/brokers/types";
// Reuse the generic, already-exported crypto/cookie primitives from the proven
// Robinhood MCP client rather than duplicating them (same PKCE S256 + signed
// state cookie scheme). Also reuse the MCP text/JSON extractors.
import {
  makePkce,
  makeState,
  signOAuthCookie,
  verifyOAuthCookie,
  mcpToolJson,
} from "@/lib/robinhood-mcp";

export { makePkce, makeState, signOAuthCookie, verifyOAuthCookie };

// Webull MCP client — Phase 1 READ-ONLY. OAuth 2.1 (PKCE S256, public client) +
// dynamic client registration + a deterministic JSON-RPC MCP client. NO order
// path exists in this file by design — this phase only reads accounts, positions,
// balances and quotes. Do NOT add an order-placement path here; orders are Phase 2
// and require the `order:write` scope, which is deliberately omitted below.
//
// Endpoints/config confirmed from Webull's public OAuth metadata + MCP docs:
//   authorization_endpoint = https://passport.webull.com/oauth2/ai-mcp/login
//   token_endpoint         = https://u1suserauth.webullfintech.com/api/userauth/oauth/token/token
//   registration_endpoint  = https://u1suserauth.webullfintech.com/api/userauth/oauth/client/register
//   MCP JSON-RPC endpoint  = https://api.webull.com/mcp
//   PKCE S256, token_endpoint_auth_method="none", grants: authorization_code + refresh_token
//   Phase-1 scope (read-only) = "account:read market:read instrument:read"  (NO order:write)

const AUTH_ENDPOINT = "https://passport.webull.com/oauth2/ai-mcp/login";
const TOKEN_ENDPOINT = "https://u1suserauth.webullfintech.com/api/userauth/oauth/token/token";
const REGISTER_ENDPOINT = "https://u1suserauth.webullfintech.com/api/userauth/oauth/client/register";
const MCP_URL = "https://api.webull.com/mcp";
// Read-only Phase 1 scopes ONLY. order:write is intentionally omitted.
const SCOPE = "account:read market:read instrument:read";

const VK = {
  clientId: "WEBULL_MCP_CLIENT_ID",
  access: "WEBULL_MCP_ACCESS_TOKEN",
  refresh: "WEBULL_MCP_REFRESH_TOKEN",
  expiry: "WEBULL_MCP_TOKEN_EXPIRES",
} as const;

// ── vault helpers ──────────────────────────────────────────────────────────
async function vaultGet(svc: any, key: string): Promise<string | null> {
  const { data } = await svc.from("api_key_vault").select("key_value").eq("key_name", key).maybeSingle();
  const v = (data as any)?.key_value;
  return typeof v === "string" && v.length > 0 ? v : null;
}
async function vaultSet(svc: any, key: string, value: string): Promise<void> {
  // api_key_vault.display_name and .provider are NOT NULL with no default — must
  // be set on insert or the write throws a not-null violation.
  const { error } = await svc.from("api_key_vault").upsert(
    { key_name: key, key_value: value, display_name: key, provider: "webull_mcp" },
    { onConflict: "key_name" }
  );
  if (error) throw new Error(`vault write failed for ${key}: ${error.message}`);
}
// Read the refresh token together with its updated_at for compare-and-swap.
async function vaultGetWithVersion(svc: any, key: string): Promise<{ value: string | null; updatedAt: string | null }> {
  const { data } = await svc.from("api_key_vault").select("key_value, updated_at").eq("key_name", key).maybeSingle();
  return { value: (data as any)?.key_value ?? null, updatedAt: (data as any)?.updated_at ?? null };
}
async function vaultDel(svc: any, keys: string[]): Promise<{ error?: string }> {
  const { error } = await svc.from("api_key_vault").delete().in("key_name", keys);
  return { error: error?.message };
}

export async function hasWebullToken(svc?: any): Promise<boolean> {
  return !!(await vaultGet(svc ?? createServiceClient(), VK.access));
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Strip anything token-shaped before persisting or logging a raw payload.
function redactStr(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, "$1[redacted]")
    .replace(/("(?:access|refresh)_token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2");
}

// ── dynamic client registration (RFC 7591) ───────────────────────────────────
export async function getOrRegisterClient(svc: any, redirectUris: string[]): Promise<{ ok: boolean; clientId?: string; error?: string }> {
  const existing = await vaultGet(svc, VK.clientId);
  if (existing) return { ok: true, clientId: existing };
  try {
    const res = await fetch(REGISTER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "Kairos FinanceOS",
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.client_id) return { ok: false, error: `registration failed (${res.status}): ${redactStr(JSON.stringify(json)).slice(0, 300)}` };
    await vaultSet(svc, VK.clientId, json.client_id);
    return { ok: true, clientId: json.client_id };
  } catch (e) { return { ok: false, error: `registration error: ${String(e)}` }; }
}

export function buildAuthUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: SCOPE,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

// ── token exchange + refresh ─────────────────────────────────────────────────
async function storeTokens(svc: any, tok: any): Promise<void> {
  // Persist the (possibly rotated) refresh token FIRST so a partial failure is
  // recoverable — mirrors the Robinhood store order.
  if (tok.refresh_token) await vaultSet(svc, VK.refresh, tok.refresh_token);
  if (tok.access_token) await vaultSet(svc, VK.access, tok.access_token);
  const ttl = Number(tok.expires_in);
  const expiry = new Date(Date.now() + (Number.isFinite(ttl) ? ttl : 3600) * 1000).toISOString();
  await vaultSet(svc, VK.expiry, expiry);
}

export async function exchangeCode(svc: any, o: { code: string; verifier: string; redirectUri: string; clientId: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: o.code,
      redirect_uri: o.redirectUri,
      client_id: o.clientId,
      code_verifier: o.verifier,
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.access_token) return { ok: false, error: `token exchange failed (${res.status}): ${redactStr(JSON.stringify(json)).slice(0, 300)}` };
    await storeTokens(svc, json);
    return { ok: true };
  } catch (e) { return { ok: false, error: `token exchange error: ${String(e)}` }; }
}

// Single-writer refresh via compare-and-swap on the refresh-token row's
// updated_at — identical strategy to the Robinhood client so two concurrent
// serverless invocations can't both call the token endpoint with a
// possibly-rotated refresh token.
async function refreshAccessToken(svc: any): Promise<{ ok: boolean; error?: string }> {
  const clientId = await vaultGet(svc, VK.clientId);
  const { value: refresh, updatedAt } = await vaultGetWithVersion(svc, VK.refresh);
  if (!clientId || !refresh) return { ok: false, error: "no refresh token" };

  // A refresh that started within the last 30s is very likely still in flight.
  if (updatedAt && Date.now() - Date.parse(updatedAt) < 30_000) {
    return { ok: false, error: "refresh in flight — retry" };
  }

  // CAS claim: only proceed if this row's updated_at is still what we read.
  const nowIso = new Date().toISOString();
  const { data: claimed } = await svc
    .from("api_key_vault")
    .update({ updated_at: nowIso })
    .eq("key_name", VK.refresh)
    .eq("updated_at", updatedAt)
    .select("key_name");
  if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) {
    // Lost the race — give the winner time to store the new access token.
    await new Promise(r => setTimeout(r, 3000));
    return { ok: true };
  }

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.access_token) return { ok: false, error: `refresh failed (${res.status})` };
    await storeTokens(svc, json);
    return { ok: true };
  } catch (e) { return { ok: false, error: `refresh error: ${String(e)}` }; }
}

export async function getValidWebullAccessToken(svc: any): Promise<{ ok: boolean; token?: string; error?: string }> {
  const token = await vaultGet(svc, VK.access);
  // No token at all = simply not connected (not a fault) — don't alert.
  if (!token) return { ok: false, error: "not connected" };
  const expiry = await vaultGet(svc, VK.expiry);
  const expMs = expiry ? Date.parse(expiry) : 0;
  if (expMs && Date.now() > expMs - 60_000) {
    const r = await refreshAccessToken(svc);
    if (!r.ok) {
      await reportIssue({
        issueKey: "broker-token:webull",
        severity: "critical", category: "broker",
        title: "Webull connection expired — reconnect required",
        detail: `Token refresh failed: ${r.error}. The Webull account snapshot will fail until you reconnect in Settings → Webull.`,
      }, svc);
      return { ok: false, error: r.error };
    }
    const fresh = await vaultGet(svc, VK.access);
    if (fresh) { await resolveIssue("broker-token:webull", svc); return { ok: true, token: fresh }; }
    return { ok: false, error: "no token after refresh" };
  }
  await resolveIssue("broker-token:webull", svc);
  return { ok: true, token };
}

// Proactive token-age health check for the Settings status card. Mirrors the
// Robinhood variant: when the access token is near/past expiry AND a refresh
// token exists, it ATTEMPTS the CAS refresh and only reports a critical issue
// when there's genuinely no way to renew without a human reconnect.
export type WebullTokenHealth = {
  connected: boolean;
  stale: boolean;
  expiresAt: string | null;
  expiresInMs: number | null;
  hasRefresh: boolean;
};
export async function checkWebullTokenHealth(svc?: any): Promise<WebullTokenHealth> {
  const s = svc ?? createServiceClient();
  const token = await vaultGet(s, VK.access);
  if (!token) {
    await resolveIssue("broker-token:webull", s);
    return { connected: false, stale: false, expiresAt: null, expiresInMs: null, hasRefresh: false };
  }
  let expiry = await vaultGet(s, VK.expiry);
  const hasRefresh = !!(await vaultGet(s, VK.refresh));
  let expMs = expiry ? Date.parse(expiry) : 0;
  const expiring = !!expMs && Date.now() > expMs - 60_000;

  if (expiring && hasRefresh) {
    const r = await refreshAccessToken(s);
    if (r.ok) {
      expiry = await vaultGet(s, VK.expiry);
      expMs = expiry ? Date.parse(expiry) : 0;
      await resolveIssue("broker-token:webull", s);
      return { connected: true, stale: false, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: true };
    }
    await reportIssue({
      issueKey: "broker-token:webull",
      severity: "critical", category: "broker",
      title: "Webull connection expired — reconnect required",
      detail: `Token refresh failed: ${r.error}. The Webull account snapshot will fail until you reconnect in Settings → Webull.`,
    }, s);
    return { connected: true, stale: true, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: true };
  }

  if (expiring && !hasRefresh) {
    await reportIssue({
      issueKey: "broker-token:webull",
      severity: "critical", category: "broker",
      title: "Webull connection expired — reconnect required",
      detail: `Stored Webull token expired ${expiry ?? "(unknown)"} and no refresh token is present. The Webull account snapshot will fail until you reconnect in Settings → Webull.`,
    }, s);
    return { connected: true, stale: true, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: false };
  }

  await resolveIssue("broker-token:webull", s);
  return { connected: true, stale: false, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh };
}

// ── deterministic MCP JSON-RPC (StreamableHTTP) ───────────────────────────────
// Minimal client: initialize → capture session id → tools/call. Parses both
// plain-JSON and text/event-stream responses. Read-only — never places orders.
function parseMcpBody(text: string, contentType: string): any {
  if (contentType.includes("text/event-stream")) {
    let last: any = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m && m[1].trim()) { try { last = JSON.parse(m[1]); } catch { /* skip */ } }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

export async function webullRpc(token: string, method: string, params: any, sessionId?: string, isNotification = false): Promise<{ ok: boolean; result?: any; error?: string; sessionId?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const reqId = b64url(randomBytes(8));
  const body: any = { jsonrpc: "2.0", method, ...(isNotification ? {} : { id: reqId }), ...(params !== undefined ? { params } : {}) };
  let res: Response;
  try {
    res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { ok: false, error: `MCP ${method} transport error: ${String(e)}`, sessionId };
  }
  const sid = res.headers.get("mcp-session-id") ?? sessionId;
  if (isNotification) return { ok: res.ok, sessionId: sid ?? undefined };
  const text = await res.text();
  const parsed = parseMcpBody(text, res.headers.get("content-type") ?? "");
  if (!res.ok) return { ok: false, error: `MCP ${method} HTTP ${res.status}: ${redactStr(text).slice(0, 300)}`, sessionId: sid ?? undefined };
  if (!parsed) return { ok: false, error: `MCP ${method}: empty/unparseable response`, sessionId: sid ?? undefined };
  if (parsed.error) return { ok: false, error: `MCP ${method} error: ${JSON.stringify(parsed.error).slice(0, 300)}`, sessionId: sid ?? undefined };
  if (parsed.id !== undefined && parsed.id !== reqId) return { ok: false, error: `MCP ${method}: response id mismatch`, sessionId: sid ?? undefined };
  if (!("result" in parsed)) return { ok: false, error: `MCP ${method}: response missing result`, sessionId: sid ?? undefined };
  if (method === "tools/call" && parsed.result?.isError === true) {
    return { ok: false, error: `MCP tool error: ${JSON.stringify(parsed.result?.content ?? parsed.result).slice(0, 300)}`, sessionId: sid ?? undefined };
  }
  return { ok: true, result: parsed.result, sessionId: sid ?? undefined };
}

async function openSession(token: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const init = await webullRpc(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kairos-financeos", version: "1.0" },
  });
  if (!init.ok) return { ok: false, error: init.error };
  await webullRpc(token, "notifications/initialized", undefined, init.sessionId, true).catch(() => {});
  return { ok: true, sessionId: init.sessionId };
}

async function listTools(token: string, sessionId?: string): Promise<{ ok: boolean; tools?: any[]; error?: string }> {
  const r = await webullRpc(token, "tools/list", {}, sessionId);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, tools: r.result?.tools ?? [] };
}

// Read every investing account visible to the owner's Webull MCP connection.
// READ-ONLY: only get_account_list / get_account_positions / get_account_balance
// and get_stock_quotes are called — never any order tool. Missing prices fail the
// affected account closed so risk analytics can't treat cost basis as a quote.
// Fail-soft: returns error stubs, never throws into callers.
export async function captureWebullAccounts(): Promise<BrokerAccount[]> {
  const fetchedAt = new Date().toISOString();
  const errorStub = (error: string, accountId = "unknown", accountLabel = "Webull"): BrokerAccount => ({
    source: "webull", accountId, accountLabel, totalValue: 0, cashBalance: 0,
    holdings: [], fetchedAt, error,
  });
  const labelFor = (id: string) => `Webull ${id}`;

  try {
    const svc = createServiceClient();
    const tk = await getValidWebullAccessToken(svc);
    if (!tk.ok || !tk.token) return [errorStub(tk.error ?? "Webull MCP is not connected")];
    const sess = await openSession(tk.token);
    if (!sess.ok) return [errorStub(sess.error ?? "Webull MCP session failed")];
    const sid = sess.sessionId;

    const accountResult = await webullRpc(tk.token, "tools/call", { name: "get_account_list", arguments: {} }, sid)
      .catch((e) => ({ ok: false as const, error: String(e) }));
    if (!accountResult.ok) return [errorStub(`get_account_list failed: ${accountResult.error}`)];
    const accountObject = mcpToolJson((accountResult as any).result?.content ?? (accountResult as any).result);
    const rawAccounts: any[] = Array.isArray(accountObject?.data?.accounts) ? accountObject.data.accounts
      : Array.isArray(accountObject?.accounts) ? accountObject.accounts
      : Array.isArray(accountObject?.data) ? accountObject.data
      : Array.isArray(accountObject) ? accountObject : [];
    if (!rawAccounts.length) return [errorStub("Webull MCP returned no accounts")];

    type Captured = { id: string; wireId: string; positions?: any[]; balance?: any; error?: string };
    const captured: Captured[] = [];
    // Limit concurrency to two accounts to keep the capture inside the serverless
    // route's execution window.
    for (let i = 0; i < rawAccounts.length; i += 2) {
      const rows = await Promise.all(rawAccounts.slice(i, i + 2).map(async (raw): Promise<Captured> => {
        const id = String(raw?.account_id ?? raw?.account_number ?? raw?.accountId ?? raw?.id ?? "").trim();
        const wireId = String(raw?.account_id ?? raw?.accountId ?? raw?.account_number ?? raw?.id ?? "").trim();
        if (!id || !wireId) return { id: "unknown", wireId: "unknown", error: "account response omitted an account id" };
        try {
          const [posResult, balResult] = await Promise.all([
            webullRpc(tk.token!, "tools/call", { name: "get_account_positions", arguments: { account_id: wireId } }, sid),
            webullRpc(tk.token!, "tools/call", { name: "get_account_balance", arguments: { account_id: wireId } }, sid),
          ]);
          if (!posResult.ok) return { id, wireId, error: `get_account_positions failed: ${posResult.error}` };
          if (!balResult.ok) return { id, wireId, error: `get_account_balance failed: ${balResult.error}` };
          const posObject = mcpToolJson(posResult.result?.content ?? posResult.result);
          const balObject = mcpToolJson(balResult.result?.content ?? balResult.result);
          const posData = posObject?.data ?? posObject;
          const positions = Array.isArray(posData?.positions) ? posData.positions
            : Array.isArray(posData?.results) ? posData.results
            : Array.isArray(posData) ? posData : null;
          if (!positions) return { id, wireId, error: "get_account_positions returned an unparseable payload" };
          if (!balObject) return { id, wireId, error: "get_account_balance returned an unparseable payload" };
          return { id, wireId, positions, balance: balObject?.data ?? balObject };
        } catch (e) {
          return { id, wireId, error: `Webull MCP account capture failed: ${String(e)}` };
        }
      }));
      captured.push(...rows);
    }

    const symbols = Array.from(new Set(captured.flatMap(a => (a.positions ?? []).map(p =>
      String(p?.symbol ?? p?.ticker ?? p?.instrument?.symbol ?? "").trim().toUpperCase(),
    )).filter(Boolean)));
    const prices = new Map<string, number>();
    let quoteError: string | undefined;
    if (symbols.length) {
      const toolList = await listTools(tk.token, sid);
      const quoteTool = toolList.tools?.find(t => t.name === "get_stock_quotes");
      if (!toolList.ok || !quoteTool) {
        quoteError = toolList.error ?? "get_stock_quotes is not offered by Webull MCP";
      } else {
        const props = quoteTool.inputSchema?.properties ?? {};
        const symbolKey = ["symbols", "symbol", "tickers"].find(k => k in props) ?? "symbols";
        for (let i = 0; i < symbols.length; i += 20) {
          const batch = symbols.slice(i, i + 20);
          const rawType = props[symbolKey]?.type;
          const declaredType = Array.isArray(rawType) ? rawType.find((t: string) => t !== "null") : rawType;
          const symbolValue = declaredType === "string" ? batch.join(",") : batch;
          try {
            const qr = await webullRpc(tk.token, "tools/call", {
              name: "get_stock_quotes", arguments: { [symbolKey]: symbolValue },
            }, sid);
            if (!qr.ok) { quoteError = qr.error ?? "get_stock_quotes failed"; break; }
            const qo = mcpToolJson(qr.result?.content ?? qr.result);
            const qd = qo?.data ?? qo;
            const quotes: any[] = Array.isArray(qd?.quotes) ? qd.quotes
              : Array.isArray(qd?.results) ? qd.results : Array.isArray(qd) ? qd : [];
            if (!quotes.length) quoteError = "get_stock_quotes returned an unparseable payload";
            for (const q of quotes) {
              const quote = q?.quote ?? q;
              const symbol = String(quote?.symbol ?? quote?.ticker ?? quote?.instrument?.symbol ?? "").trim().toUpperCase();
              const price = Number(quote?.last_price ?? quote?.last_trade_price ?? quote?.close
                ?? quote?.current_price ?? quote?.mark_price ?? quote?.price);
              if (symbol && Number.isFinite(price) && price > 0) prices.set(symbol, price);
            }
          } catch (e) { quoteError = String(e); break; }
        }
      }
    }

    return captured.map((a): BrokerAccount => {
      const label = labelFor(a.id);
      if (a.error) return errorStub(a.error, a.id, label);
      const holdings: BrokerHolding[] = [];
      const missingQuotes: string[] = [];
      for (const p of a.positions ?? []) {
        const symbol = String(p?.symbol ?? p?.ticker ?? p?.instrument?.symbol ?? "").trim().toUpperCase();
        const qty = Number(p?.quantity ?? p?.qty ?? p?.shares ?? p?.position ?? 0);
        if (!symbol || !Number.isFinite(qty) || qty <= 0) continue;
        const averageCost = Number(p?.cost_price ?? p?.average_cost ?? p?.average_price ?? p?.avg_price ?? p?.avg_cost ?? 0);
        const fallbackPrice = Number(p?.last_price ?? p?.market_price ?? 0);
        const currentPrice = prices.get(symbol) ?? (fallbackPrice > 0 ? fallbackPrice : undefined);
        if (!currentPrice) { missingQuotes.push(symbol); continue; }
        const marketValue = qty * currentPrice;
        const costBasis = Number.isFinite(averageCost) && averageCost >= 0 ? qty * averageCost : undefined;
        holdings.push({
          symbol, qty, currentPrice, marketValue, costBasis,
          unrealizedPnl: costBasis == null ? undefined : marketValue - costBasis,
          unrealizedPnlPct: costBasis != null && costBasis > 0 ? ((marketValue - costBasis) / costBasis) * 100 : undefined,
          side: "long", source: "webull",
        });
      }
      if (missingQuotes.length) {
        const suffix = quoteError ? ` (${quoteError})` : "";
        return errorStub(`Current quote unavailable for ${missingQuotes.join(", ")}${suffix}`, a.id, label);
      }
      const balance = a.balance ?? {};
      const totalValue = Number(balance?.total_value ?? balance?.net_liquidation ?? balance?.net_asset_value
        ?? balance?.total_asset ?? balance?.equity);
      const cashBalance = Number(balance?.cash ?? balance?.cash_balance ?? balance?.settled_cash
        ?? balance?.available_cash ?? 0);
      const buyingPower = Number(balance?.buying_power ?? balance?.day_buying_power ?? 0);
      if (!Number.isFinite(totalValue) || totalValue < 0) {
        return errorStub("get_account_balance omitted a valid total value", a.id, label);
      }
      return {
        source: "webull", accountId: a.id, accountLabel: label, totalValue,
        cashBalance: Number.isFinite(cashBalance) && cashBalance >= 0 ? cashBalance : 0,
        buyingPower: Number.isFinite(buyingPower) && buyingPower >= 0
          ? buyingPower
          : (Number.isFinite(cashBalance) && cashBalance >= 0 ? cashBalance : undefined),
        holdings, fetchedAt,
      };
    });
  } catch (e) {
    // Absolute fail-soft: never throw into callers (dashboard/risk pipeline).
    return [errorStub(`Webull MCP capture error: ${String(e)}`)];
  }
}

// Kill switch: wipe local Webull tokens regardless of remote reachability.
export async function disconnectWebullMcp(svc?: any): Promise<{ ok: boolean; error?: string }> {
  const s = svc ?? createServiceClient();
  const { error } = await vaultDel(s, [VK.access, VK.refresh, VK.expiry]);
  return { ok: !error, error };
}

// ── Server-side OAuth state (migration 173) ─────────────────────────────────
// The state+PKCE-verifier were kept in a 10-min HttpOnly cookie, but Webull's
// OAuth is multi-screen (login → trading password → account select → capability
// select), so the cookie routinely expired or wasn't returned on the callback
// (cross-domain), yielding "state check failed". Storing it server-side keyed by
// the state nonce is immune to cookie/domain/expiry — the callback just looks it
// up. Single-use (deleted on read), 30-min TTL, service-role only.
export async function saveOAuthState(
  svc: any, state: string, verifier: string, redirectUri: string, provider = "webull",
): Promise<void> {
  await svc.from("oauth_pkce_state").insert({
    state, provider, verifier, redirect_uri: redirectUri,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
}
export async function consumeOAuthState(
  svc: any, state: string, provider = "webull",
): Promise<{ verifier: string; redirectUri: string | null } | null> {
  const { data } = await svc.from("oauth_pkce_state")
    .select("verifier, redirect_uri, expires_at, provider").eq("state", state).maybeSingle();
  if (!data) return null;
  await svc.from("oauth_pkce_state").delete().eq("state", state); // single-use
  if ((data as any).provider !== provider) return null;
  if (new Date((data as any).expires_at).getTime() < Date.now()) return null;
  return { verifier: (data as any).verifier, redirectUri: (data as any).redirect_uri ?? null };
}
