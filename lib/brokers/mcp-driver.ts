import { createServiceClient } from "@/lib/supabase/service";
import { randomBytes } from "crypto";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import type { BrokerAccount, BrokerHolding, BrokerName } from "@/lib/brokers/types";
import type { McpBrokerConfig } from "@/lib/brokers/mcp-registry";
// Reuse the proven crypto/cookie + MCP JSON extraction primitives from the
// Robinhood MCP client rather than duplicating them (identical PKCE S256 +
// signed-state-cookie scheme, identical tool-result JSON shape).
import {
  makePkce,
  makeState,
  signOAuthCookie,
  verifyOAuthCookie,
  mcpToolJson,
} from "@/lib/robinhood-mcp";

export { makePkce, makeState, signOAuthCookie, verifyOAuthCookie, mcpToolJson };

// Generic, config-driven MCP broker driver — Phase-1 READ-ONLY. Every function
// takes an `McpBrokerConfig` (from lib/brokers/mcp-registry.ts) so a new broker
// is added by a config entry, not new code. This file GENERALIZES the bespoke
// lib/webull-mcp.ts driver: OAuth 2.1 (PKCE S256, dynamic client registration,
// CAS refresh) + a deterministic JSON-RPC MCP client + a snapshot capture driven
// by cfg.tools + cfg.fields. There is NO order path here by design — only
// account/position/balance/quote reads. Do NOT add order placement to this file.

// ── field pickers ─────────────────────────────────────────────────────────
// Resolve the first candidate key (dotted paths supported) that yields a value.
function pick(obj: any, paths: string[]): any {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const seg of path.split(".")) {
      if (cur && typeof cur === "object" && seg in cur) cur = cur[seg];
      else { ok = false; break; }
    }
    if (ok && cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}
function pickStr(obj: any, paths: string[]): string {
  const v = pick(obj, paths);
  return v == null ? "" : String(v).trim();
}
function pickNum(obj: any, paths: string[]): number {
  return Number(pick(obj, paths));
}

// ── vault helpers (keyed by cfg.vaultKeys / cfg.vaultProvider) ──────────────
async function vaultGet(svc: any, key: string): Promise<string | null> {
  const { data } = await svc.from("api_key_vault").select("key_value").eq("key_name", key).maybeSingle();
  const v = (data as any)?.key_value;
  return typeof v === "string" && v.length > 0 ? v : null;
}
async function vaultSet(svc: any, cfg: McpBrokerConfig, key: string, value: string): Promise<void> {
  // api_key_vault.display_name and .provider are NOT NULL with no default — must
  // be set on insert or the write throws a not-null violation.
  const { error } = await svc.from("api_key_vault").upsert(
    {
      key_name: key, key_value: value, display_name: key, provider: cfg.vaultProvider,
      // See lib/robinhood-mcp.ts vaultSet: the column only moved on the CAS
      // claim, so token rows kept their original insert timestamp forever.
      updated_at: new Date().toISOString(),
    },
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

export async function hasToken(svc: any, cfg: McpBrokerConfig): Promise<boolean> {
  return !!(await vaultGet(svc ?? createServiceClient(), cfg.vaultKeys.access));
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

// ── dynamic client registration (RFC 7591) ──────────────────────────────────
export async function getOrRegisterClient(
  svc: any, cfg: McpBrokerConfig, redirectUris: string[],
): Promise<{ ok: boolean; clientId?: string; error?: string }> {
  const existing = await vaultGet(svc, cfg.vaultKeys.clientId);
  if (existing) return { ok: true, clientId: existing };
  try {
    const res = await fetch(cfg.oauth.registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: cfg.clientName,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: cfg.oauth.publicClient ? "none" : "client_secret_basic",
        scope: cfg.oauth.scopes,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.client_id) return { ok: false, error: `registration failed (${res.status}): ${redactStr(JSON.stringify(json)).slice(0, 300)}` };
    await vaultSet(svc, cfg, cfg.vaultKeys.clientId, json.client_id);
    return { ok: true, clientId: json.client_id };
  } catch (e) { return { ok: false, error: `registration error: ${String(e)}` }; }
}

export function buildAuthUrl(
  cfg: McpBrokerConfig, o: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: cfg.oauth.scopes,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  });
  return `${cfg.oauth.authorizeUrl}?${p.toString()}`;
}

// ── token exchange + refresh ─────────────────────────────────────────────────
async function storeTokens(svc: any, cfg: McpBrokerConfig, tok: any): Promise<void> {
  // Persist the (possibly rotated) refresh token FIRST so a partial failure is
  // recoverable — mirrors the Robinhood/Webull store order.
  if (tok.refresh_token) await vaultSet(svc, cfg, cfg.vaultKeys.refresh, tok.refresh_token);
  if (tok.access_token) await vaultSet(svc, cfg, cfg.vaultKeys.access, tok.access_token);
  const ttl = Number(tok.expires_in);
  const expiry = new Date(Date.now() + (Number.isFinite(ttl) ? ttl : 3600) * 1000).toISOString();
  await vaultSet(svc, cfg, cfg.vaultKeys.expiry, expiry);
}

export async function exchangeCode(
  svc: any, cfg: McpBrokerConfig, o: { code: string; verifier: string; redirectUri: string; clientId: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: o.code,
      redirect_uri: o.redirectUri,
      client_id: o.clientId,
      code_verifier: o.verifier,
    });
    const res = await fetch(cfg.oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.access_token) return { ok: false, error: `token exchange failed (${res.status}): ${redactStr(JSON.stringify(json)).slice(0, 300)}` };
    await storeTokens(svc, cfg, json);
    return { ok: true };
  } catch (e) { return { ok: false, error: `token exchange error: ${String(e)}` }; }
}

// Single-writer refresh via compare-and-swap on the refresh-token row's
// updated_at — identical strategy to the Robinhood/Webull client so two
// concurrent serverless invocations can't both call the token endpoint with a
// possibly-rotated refresh token.
async function refreshAccessToken(svc: any, cfg: McpBrokerConfig): Promise<{ ok: boolean; error?: string }> {
  const clientId = await vaultGet(svc, cfg.vaultKeys.clientId);
  const { value: refresh, updatedAt } = await vaultGetWithVersion(svc, cfg.vaultKeys.refresh);
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
    .eq("key_name", cfg.vaultKeys.refresh)
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
    const res = await fetch(cfg.oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.access_token) return { ok: false, error: `refresh failed (${res.status})` };
    await storeTokens(svc, cfg, json);
    return { ok: true };
  } catch (e) { return { ok: false, error: `refresh error: ${String(e)}` }; }
}

export async function getValidAccessToken(svc: any, cfg: McpBrokerConfig): Promise<{ ok: boolean; token?: string; error?: string }> {
  const issueKey = `broker-token:${cfg.id}`;
  const token = await vaultGet(svc, cfg.vaultKeys.access);
  // No token at all = simply not connected (not a fault) — don't alert.
  if (!token) return { ok: false, error: "not connected" };
  const expiry = await vaultGet(svc, cfg.vaultKeys.expiry);
  const expMs = expiry ? Date.parse(expiry) : 0;
  if (expMs && Date.now() > expMs - 60_000) {
    const r = await refreshAccessToken(svc, cfg);
    if (!r.ok) {
      await reportIssue({
        issueKey,
        severity: "critical", category: "broker",
        title: `${cfg.label} connection expired — reconnect required`,
        detail: `Token refresh failed: ${r.error}. The ${cfg.label} account snapshot will fail until you reconnect in Settings → ${cfg.label}.`,
      }, svc);
      return { ok: false, error: r.error };
    }
    const fresh = await vaultGet(svc, cfg.vaultKeys.access);
    if (fresh) { await resolveIssue(issueKey, svc); return { ok: true, token: fresh }; }
    return { ok: false, error: "no token after refresh" };
  }
  await resolveIssue(issueKey, svc);
  return { ok: true, token };
}

// Proactive token-age health check for the Settings status card. When the access
// token is near/past expiry AND a refresh token exists, it ATTEMPTS the CAS
// refresh and only reports a critical issue when there's genuinely no way to
// renew without a human reconnect.
export type McpTokenHealth = {
  connected: boolean;
  stale: boolean;
  expiresAt: string | null;
  expiresInMs: number | null;
  hasRefresh: boolean;
};
export async function checkTokenHealth(svc: any, cfg: McpBrokerConfig): Promise<McpTokenHealth> {
  const s = svc ?? createServiceClient();
  const issueKey = `broker-token:${cfg.id}`;
  const token = await vaultGet(s, cfg.vaultKeys.access);
  if (!token) {
    await resolveIssue(issueKey, s);
    return { connected: false, stale: false, expiresAt: null, expiresInMs: null, hasRefresh: false };
  }
  let expiry = await vaultGet(s, cfg.vaultKeys.expiry);
  const hasRefresh = !!(await vaultGet(s, cfg.vaultKeys.refresh));
  let expMs = expiry ? Date.parse(expiry) : 0;
  const expiring = !!expMs && Date.now() > expMs - 60_000;

  if (expiring && hasRefresh) {
    const r = await refreshAccessToken(s, cfg);
    if (r.ok) {
      expiry = await vaultGet(s, cfg.vaultKeys.expiry);
      expMs = expiry ? Date.parse(expiry) : 0;
      await resolveIssue(issueKey, s);
      return { connected: true, stale: false, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: true };
    }
    await reportIssue({
      issueKey,
      severity: "critical", category: "broker",
      title: `${cfg.label} connection expired — reconnect required`,
      detail: `Token refresh failed: ${r.error}. The ${cfg.label} account snapshot will fail until you reconnect in Settings → ${cfg.label}.`,
    }, s);
    return { connected: true, stale: true, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: true };
  }

  if (expiring && !hasRefresh) {
    await reportIssue({
      issueKey,
      severity: "critical", category: "broker",
      title: `${cfg.label} connection expired — reconnect required`,
      detail: `Stored ${cfg.label} token expired ${expiry ?? "(unknown)"} and no refresh token is present. The ${cfg.label} account snapshot will fail until you reconnect in Settings → ${cfg.label}.`,
    }, s);
    return { connected: true, stale: true, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: false };
  }

  await resolveIssue(issueKey, s);
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

export async function mcpRpc(
  cfg: McpBrokerConfig, token: string, method: string, params: any, sessionId?: string, isNotification = false,
): Promise<{ ok: boolean; result?: any; error?: string; sessionId?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": cfg.protocolVersion,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const reqId = b64url(randomBytes(8));
  const body: any = { jsonrpc: "2.0", method, ...(isNotification ? {} : { id: reqId }), ...(params !== undefined ? { params } : {}) };
  let res: Response;
  try {
    res = await fetch(cfg.mcpUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { ok: false, error: `MCP ${method} transport error: ${String(e)}`, sessionId };
  }
  const sid = res.headers.get("mcp-session-id") ?? sessionId;
  if (isNotification) return { ok: res.ok, sessionId: sid ?? undefined };
  const text = await res.text();
  const parsed = parseMcpBody(text, res.headers.get("content-type") ?? "");
  if (!res.ok) return { ok: false, error: `MCP ${method} HTTP ${res.status}: ${redactStr(text).slice(0, 300)}`, sessionId: sid ?? undefined };
  if (!parsed) return { ok: false, error: `MCP ${method}: empty/unparseable response`, sessionId: sid ?? undefined };
  if (parsed.error) return { ok: false, error: `MCP ${method} error: ${redactStr(JSON.stringify(parsed.error)).slice(0, 300)}`, sessionId: sid ?? undefined };
  if (parsed.id !== undefined && parsed.id !== reqId) return { ok: false, error: `MCP ${method}: response id mismatch`, sessionId: sid ?? undefined };
  if (!("result" in parsed)) return { ok: false, error: `MCP ${method}: response missing result`, sessionId: sid ?? undefined };
  if (method === "tools/call" && parsed.result?.isError === true) {
    return { ok: false, error: `MCP tool error: ${redactStr(JSON.stringify(parsed.result?.content ?? parsed.result)).slice(0, 300)}`, sessionId: sid ?? undefined };
  }
  return { ok: true, result: parsed.result, sessionId: sid ?? undefined };
}

async function openSession(cfg: McpBrokerConfig, token: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const init = await mcpRpc(cfg, token, "initialize", {
    protocolVersion: cfg.protocolVersion,
    capabilities: {},
    clientInfo: { name: "kairos-financeos", version: "1.0" },
  });
  if (!init.ok) return { ok: false, error: init.error };
  await mcpRpc(cfg, token, "notifications/initialized", undefined, init.sessionId, true).catch(() => {});
  return { ok: true, sessionId: init.sessionId };
}

async function listTools(cfg: McpBrokerConfig, token: string, sessionId?: string): Promise<{ ok: boolean; tools?: any[]; error?: string }> {
  const r = await mcpRpc(cfg, token, "tools/list", {}, sessionId);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, tools: r.result?.tools ?? [] };
}

// Common wrapper resolution: a broker returns its array either at data.<key>,
// <key>, results, data, or the bare root. Matches the shapes both Webull and
// Robinhood use, so it stays in the driver rather than per-broker config.
function extractArray(obj: any, key: string): any[] | null {
  const data = obj?.data ?? obj;
  if (Array.isArray(obj?.data?.[key])) return obj.data[key];
  if (Array.isArray(obj?.[key])) return obj[key];
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(obj?.results)) return obj.results;
  if (Array.isArray(data)) return data;
  if (Array.isArray(obj)) return obj;
  return null;
}

// Read every investing account visible to the owner's connection for `cfg`.
// READ-ONLY: only the four cfg.tools (accountList/positions/balance/quotes) are
// ever called — never any order tool. Missing prices fail the affected account
// closed so risk analytics can't treat cost basis as a quote. Fail-soft: returns
// error stubs, never throws into callers. Same BrokerAccount[] shape as the old
// captureWebullAccounts.
export async function captureAccounts(cfg: McpBrokerConfig): Promise<BrokerAccount[]> {
  const source = cfg.id as BrokerName;
  const fetchedAt = new Date().toISOString();
  const errorStub = (error: string, accountId = "unknown", accountLabel = cfg.label): BrokerAccount => ({
    source, accountId, accountLabel, totalValue: 0, cashBalance: 0,
    holdings: [], fetchedAt, error,
  });
  const labelFor = (id: string) => `${cfg.label} ${id}`;

  try {
    const svc = createServiceClient();
    const tk = await getValidAccessToken(svc, cfg);
    if (!tk.ok || !tk.token) return [errorStub(tk.error ?? `${cfg.label} MCP is not connected`)];
    const sess = await openSession(cfg, tk.token);
    if (!sess.ok) return [errorStub(sess.error ?? `${cfg.label} MCP session failed`)];
    const sid = sess.sessionId;

    const accountResult = await mcpRpc(cfg, tk.token, "tools/call", { name: cfg.tools.accountList, arguments: {} }, sid)
      .catch((e) => ({ ok: false as const, error: String(e) }));
    if (!accountResult.ok) return [errorStub(`${cfg.tools.accountList} failed: ${(accountResult as any).error}`)];
    const accountObject = mcpToolJson((accountResult as any).result?.content ?? (accountResult as any).result);
    const rawAccounts = extractArray(accountObject, "accounts") ?? [];
    if (!rawAccounts.length) return [errorStub(`${cfg.label} MCP returned no accounts`)];

    type Captured = { id: string; wireId: string; positions?: any[]; balance?: any; error?: string };
    const captured: Captured[] = [];
    // Limit concurrency to two accounts to keep the capture inside the serverless
    // route's execution window.
    for (let i = 0; i < rawAccounts.length; i += 2) {
      const rows = await Promise.all(rawAccounts.slice(i, i + 2).map(async (raw): Promise<Captured> => {
        const id = pickStr(raw, cfg.fields.accountId);
        const wireId = id;
        if (!id || !wireId) return { id: "unknown", wireId: "unknown", error: "account response omitted an account id" };
        try {
          const [posResult, balResult] = await Promise.all([
            mcpRpc(cfg, tk.token!, "tools/call", { name: cfg.tools.positions, arguments: { account_id: wireId } }, sid),
            mcpRpc(cfg, tk.token!, "tools/call", { name: cfg.tools.balance, arguments: { account_id: wireId } }, sid),
          ]);
          if (!posResult.ok) return { id, wireId, error: `${cfg.tools.positions} failed: ${posResult.error}` };
          if (!balResult.ok) return { id, wireId, error: `${cfg.tools.balance} failed: ${balResult.error}` };
          const posObject = mcpToolJson(posResult.result?.content ?? posResult.result);
          const balObject = mcpToolJson(balResult.result?.content ?? balResult.result);
          const positions = extractArray(posObject, "positions");
          if (!positions) return { id, wireId, error: `${cfg.tools.positions} returned an unparseable payload` };
          if (!balObject) return { id, wireId, error: `${cfg.tools.balance} returned an unparseable payload` };
          return { id, wireId, positions, balance: balObject?.data ?? balObject };
        } catch (e) {
          return { id, wireId, error: `${cfg.label} MCP account capture failed: ${String(e)}` };
        }
      }));
      captured.push(...rows);
    }

    const symbols = Array.from(new Set(captured.flatMap(a => (a.positions ?? []).map(p =>
      pickStr(p, cfg.fields.symbol).toUpperCase(),
    )).filter(Boolean)));
    const prices = new Map<string, number>();
    let quoteError: string | undefined;
    if (symbols.length) {
      const toolList = await listTools(cfg, tk.token, sid);
      const quoteTool = toolList.tools?.find(t => t.name === cfg.tools.quotes);
      if (!toolList.ok || !quoteTool) {
        quoteError = toolList.error ?? `${cfg.tools.quotes} is not offered by ${cfg.label} MCP`;
      } else {
        const props = quoteTool.inputSchema?.properties ?? {};
        const symbolKey = cfg.fields.quoteSymbolKeys.find(k => k in props) ?? cfg.fields.quoteSymbolKeys[0];
        for (let i = 0; i < symbols.length; i += 20) {
          const batch = symbols.slice(i, i + 20);
          const rawType = props[symbolKey]?.type;
          const declaredType = Array.isArray(rawType) ? rawType.find((t: string) => t !== "null") : rawType;
          const symbolValue = declaredType === "string" ? batch.join(",") : batch;
          try {
            const qr = await mcpRpc(cfg, tk.token, "tools/call", {
              name: cfg.tools.quotes, arguments: { [symbolKey]: symbolValue },
            }, sid);
            if (!qr.ok) { quoteError = qr.error ?? `${cfg.tools.quotes} failed`; break; }
            const qo = mcpToolJson(qr.result?.content ?? qr.result);
            const quotes = extractArray(qo, "quotes") ?? [];
            if (!quotes.length) quoteError = `${cfg.tools.quotes} returned an unparseable payload`;
            for (const q of quotes) {
              const quote = q?.quote ?? q;
              const symbol = pickStr(quote, cfg.fields.symbol).toUpperCase();
              const price = pickNum(quote, cfg.fields.price);
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
        const symbol = pickStr(p, cfg.fields.symbol).toUpperCase();
        const qty = pickNum(p, cfg.fields.qty);
        if (!symbol || !Number.isFinite(qty) || qty <= 0) continue;
        const averageCost = pickNum(p, cfg.fields.avgCost);
        const fallbackPrice = pickNum(p, cfg.fields.positionPrice);
        const currentPrice = prices.get(symbol) ?? (Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : undefined);
        if (!currentPrice) { missingQuotes.push(symbol); continue; }
        const marketValue = qty * currentPrice;
        const costBasis = Number.isFinite(averageCost) && averageCost >= 0 ? qty * averageCost : undefined;
        holdings.push({
          symbol, qty, currentPrice, marketValue, costBasis,
          unrealizedPnl: costBasis == null ? undefined : marketValue - costBasis,
          unrealizedPnlPct: costBasis != null && costBasis > 0 ? ((marketValue - costBasis) / costBasis) * 100 : undefined,
          side: "long", source,
        });
      }
      if (missingQuotes.length) {
        const suffix = quoteError ? ` (${quoteError})` : "";
        return errorStub(`Current quote unavailable for ${missingQuotes.join(", ")}${suffix}`, a.id, label);
      }
      const balance = a.balance ?? {};
      const totalValue = pickNum(balance, cfg.fields.equity);
      const cashBalance = Number(pick(balance, cfg.fields.cash) ?? 0);
      const buyingPower = Number(pick(balance, cfg.fields.buyingPower) ?? 0);
      if (!Number.isFinite(totalValue) || totalValue < 0) {
        return errorStub(`${cfg.tools.balance} omitted a valid total value`, a.id, label);
      }
      return {
        source, accountId: a.id, accountLabel: label, totalValue,
        cashBalance: Number.isFinite(cashBalance) && cashBalance >= 0 ? cashBalance : 0,
        buyingPower: Number.isFinite(buyingPower) && buyingPower >= 0
          ? buyingPower
          : (Number.isFinite(cashBalance) && cashBalance >= 0 ? cashBalance : undefined),
        holdings, fetchedAt,
      };
    });
  } catch (e) {
    // Absolute fail-soft: never throw into callers (dashboard/risk pipeline).
    return [errorStub(`${cfg.label} MCP capture error: ${String(e)}`)];
  }
}

// Kill switch: wipe local tokens regardless of remote reachability.
export async function disconnect(svc: any, cfg: McpBrokerConfig): Promise<{ ok: boolean; error?: string }> {
  const s = svc ?? createServiceClient();
  const { error } = await vaultDel(s, [cfg.vaultKeys.access, cfg.vaultKeys.refresh, cfg.vaultKeys.expiry]);
  return { ok: !error, error };
}

// ── Server-side OAuth state (oauth_pkce_state, migration 173) ───────────────
// The state+PKCE-verifier were kept in a short HttpOnly cookie, but multi-screen
// broker OAuth (login → password → account select → capability select) routinely
// outlived the cookie or dropped it cross-domain, yielding "state check failed".
// Storing it server-side keyed by the state nonce is immune to cookie/domain/
// expiry — the callback just looks it up. Single-use (deleted on read), 30-min
// TTL, service-role only. `provider` is the broker id so brokers can't collide.
export async function saveOAuthState(
  svc: any, state: string, verifier: string, redirectUri: string, provider: string,
): Promise<void> {
  await svc.from("oauth_pkce_state").insert({
    state, provider, verifier, redirect_uri: redirectUri,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
}
export async function consumeOAuthState(
  svc: any, state: string, provider: string,
): Promise<{ verifier: string; redirectUri: string | null } | null> {
  // Atomic single-use claim: delete and return the row in one statement. A
  // replay or racing duplicate callback gets zero rows and cannot reuse the
  // verifier for a second token exchange.
  const { data } = await svc.from("oauth_pkce_state")
    .delete()
    .eq("state", state)
    .eq("provider", provider)
    .select("verifier, redirect_uri, expires_at, provider")
    .maybeSingle();
  if (!data) return null;
  if (new Date((data as any).expires_at).getTime() < Date.now()) return null;
  return { verifier: (data as any).verifier, redirectUri: (data as any).redirect_uri ?? null };
}
