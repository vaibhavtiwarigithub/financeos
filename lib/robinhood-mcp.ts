import { createServiceClient } from "@/lib/supabase/service";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import type { BrokerAccount, BrokerHolding } from "@/lib/brokers/types";

// Robinhood MCP client — OAuth 2.1 (PKCE, public client) + a deterministic
// JSON-RPC MCP client. Endpoints below are VERIFIED against Robinhood's live
// well-known metadata (2026-07-07), not guessed:
//   authorization_endpoint = https://robinhood.com/oauth
//   token_endpoint         = https://api.robinhood.com/oauth2/token/
//   registration_endpoint  = https://agent.robinhood.com/oauth/trading/register
//   scope="internal", PKCE S256, token_endpoint_auth_method="none"
//   resource               = https://agent.robinhood.com/mcp/trading
//
// BINDING RULE (R1): the order write path is deterministic typed code. NO LLM
// ever constructs, relays, or "confirms" an order payload. Do not add one.

const AUTH_ENDPOINT = "https://robinhood.com/oauth";
const TOKEN_ENDPOINT = "https://api.robinhood.com/oauth2/token/";
const REGISTER_ENDPOINT = "https://agent.robinhood.com/oauth/trading/register";
const MCP_URL = "https://agent.robinhood.com/mcp/trading";
const RESOURCE = "https://agent.robinhood.com/mcp/trading";
const SCOPE = "internal";

const VK = {
  clientId: "ROBINHOOD_MCP_CLIENT_ID",
  access: "ROBINHOOD_MCP_ACCESS_TOKEN",
  refresh: "ROBINHOOD_MCP_REFRESH_TOKEN",
  expiry: "ROBINHOOD_MCP_TOKEN_EXPIRY",
} as const;

// ── vault helpers ──────────────────────────────────────────────────────────
async function vaultGet(svc: any, key: string): Promise<string | null> {
  const { data } = await svc.from("api_key_vault").select("key_value").eq("key_name", key).maybeSingle();
  const v = (data as any)?.key_value;
  return typeof v === "string" && v.length > 0 ? v : null;
}
async function vaultSet(svc: any, key: string, value: string): Promise<void> {
  // api_key_vault.display_name and .provider are NOT NULL with no default —
  // must be set on insert or the write throws a not-null violation (which is
  // what silently broke registration + token storage before this fix).
  const { error } = await svc.from("api_key_vault").upsert(
    { key_name: key, key_value: value, display_name: key, provider: "robinhood_mcp" },
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

export async function hasRobinhoodToken(svc?: any): Promise<boolean> {
  return !!(await vaultGet(svc ?? createServiceClient(), VK.access));
}

// ── PKCE + state cookie signing ──────────────────────────────────────────────
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
export function makeState(): string { return b64url(randomBytes(24)); }

function stateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (secret && secret.length >= 32) return secret;
  // Never fall back to CRON_SECRET / service-role key (couples OAuth cookie
  // integrity to broader high-value secrets) or a hardcoded string in prod.
  if (process.env.NODE_ENV !== "production") return "local-dev-only-oauth-state-secret-please-set-OAUTH_STATE_SECRET";
  throw new Error("OAUTH_STATE_SECRET must be set to >=32 chars in production");
}
// Sign {state, verifier, exp} into a compact tamper-proof cookie value.
export function signOAuthCookie(payload: { state: string; verifier: string; exp: number }): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", stateSecret()).update(body).digest());
  return `${body}.${sig}`;
}
export function verifyOAuthCookie(cookie: string | undefined): { state: string; verifier: string } | null {
  if (!cookie || !cookie.includes(".")) return null;
  const [body, sig] = cookie.split(".");
  const expected = b64url(createHmac("sha256", stateSecret()).update(body).digest());
  try {
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return { state: payload.state, verifier: payload.verifier };
  } catch { return null; }
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
    resource: RESOURCE,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

// ── token exchange + refresh ─────────────────────────────────────────────────
async function storeTokens(svc: any, tok: any): Promise<void> {
  // Persist the (possibly rotated) refresh token FIRST. Robinhood may rotate
  // the refresh token on each use and invalidate the old one; if the access
  // write succeeded but the refresh write then threw, the new refresh token
  // would be lost and the connection bricked. Refresh-first makes a partial
  // failure recoverable (old access token still works until expiry).
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
      resource: RESOURCE,
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
// updated_at: claim the refresh by CAS-updating updated_at to now; if the row
// changed under us (another process refreshed first) we lose the race and
// re-read instead of calling the token endpoint with a possibly-rotated token.
async function refreshAccessToken(svc: any): Promise<{ ok: boolean; error?: string }> {
  const clientId = await vaultGet(svc, VK.clientId);
  const { value: refresh, updatedAt } = await vaultGetWithVersion(svc, VK.refresh);
  if (!clientId || !refresh) return { ok: false, error: "no refresh token" };

  // A refresh that started within the last 30s is very likely still in flight
  // (the token endpoint round-trip is 1-15s). Treat the row as claimed and back
  // off — otherwise a caller that reads the row AFTER the winner's CAS claim but
  // BEFORE storeTokens completes would pass its own CAS and call the endpoint
  // with the OLD refresh token; if Robinhood rotates+invalidates on reuse, the
  // connection bricks. Retryable, not a hard failure.
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
    // Lost the race — another writer is refreshing. Give the winner time to
    // store the new access token before the caller re-reads it (else the caller
    // proceeds with the still-old, expired access token and 401s).
    await new Promise(r => setTimeout(r, 3000));
    return { ok: true };
  }

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      resource: RESOURCE,
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

export async function getValidAccessToken(svc: any): Promise<{ ok: boolean; token?: string; error?: string }> {
  const token = await vaultGet(svc, VK.access);
  // No token at all = simply not connected (not a fault) — don't alert.
  if (!token) return { ok: false, error: "not connected" };
  const expiry = await vaultGet(svc, VK.expiry);
  const expMs = expiry ? Date.parse(expiry) : 0;
  if (expMs && Date.now() > expMs - 60_000) {
    const r = await refreshAccessToken(svc);
    if (!r.ok) {
      // A previously-working connection whose refresh broke IS a fault — live
      // trading and the account snapshot silently stop working until reconnect.
      await reportIssue({
        issueKey: "broker-token:robinhood",
        severity: "critical", category: "broker",
        title: "Robinhood connection expired — reconnect required",
        detail: `Token refresh failed: ${r.error}. Live Robinhood orders and the account snapshot will fail until you reconnect in Settings → Robinhood.`,
      }, svc);
      return { ok: false, error: r.error };
    }
    const fresh = await vaultGet(svc, VK.access);
    if (fresh) { await resolveIssue("broker-token:robinhood", svc); return { ok: true, token: fresh }; }
    return { ok: false, error: "no token after refresh" };
  }
  await resolveIssue("broker-token:robinhood", svc);
  return { ok: true, token };
}

// Proactive Robinhood token-age health check. Robinhood access tokens are
// short-lived (~days); a plain expiry read would false-alarm every few days even
// though the stored refresh token silently renews them. So this mirrors
// getValidAccessToken: when the access token is past (or within 60s of) expiry
// AND a refresh token exists, it ATTEMPTS the CAS refresh (keeping the token warm
// on the 6h health-triage cadence). It reports the critical `broker-token:robinhood`
// issue ONLY when there's no refresh token or the refresh actually fails — i.e. a
// genuine reconnect-required state, not a routine short-TTL rollover. Returns the
// shape the Settings status route needs.
export type RobinhoodTokenHealth = {
  connected: boolean;   // access token present in vault (after any refresh)
  stale: boolean;       // still past expiry after a refresh attempt = genuine fault
  expiresAt: string | null;
  expiresInMs: number | null;
  hasRefresh: boolean;  // a refresh token exists to renew without a reconnect
};
export async function checkRobinhoodTokenHealth(svc?: any): Promise<RobinhoodTokenHealth> {
  const s = svc ?? createServiceClient();
  const token = await vaultGet(s, VK.access);
  if (!token) {
    // No token = simply not connected (not a fault). Clear any stale alert.
    await resolveIssue("broker-token:robinhood", s);
    return { connected: false, stale: false, expiresAt: null, expiresInMs: null, hasRefresh: false };
  }
  let expiry = await vaultGet(s, VK.expiry);
  const hasRefresh = !!(await vaultGet(s, VK.refresh));
  let expMs = expiry ? Date.parse(expiry) : 0;
  // Expiring = past expiry or inside the 60s pre-expiry window getValidAccessToken uses.
  const expiring = !!expMs && Date.now() > expMs - 60_000;

  if (expiring && hasRefresh) {
    // Routine short-TTL rollover: renew instead of alarming. CAS-guarded, so
    // concurrent callers don't double-refresh.
    const r = await refreshAccessToken(s);
    if (r.ok) {
      // Re-read the freshened expiry; connection is healthy, clear any alert.
      expiry = await vaultGet(s, VK.expiry);
      expMs = expiry ? Date.parse(expiry) : 0;
      await resolveIssue("broker-token:robinhood", s);
      return { connected: true, stale: false, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: true };
    }
    // Refresh token itself is dead (the failure mode that dropped all RH accounts).
    await reportIssue({
      issueKey: "broker-token:robinhood",
      severity: "critical", category: "broker",
      title: "Robinhood connection expired — reconnect required",
      detail: `Token refresh failed: ${r.error}. Live Robinhood orders, the account snapshot, and holding-risk for all Robinhood accounts will fail until you reconnect in Settings → Robinhood.`,
    }, s);
    return { connected: true, stale: true, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: true };
  }

  if (expiring && !hasRefresh) {
    // Expired with no way to renew without a human reconnect.
    await reportIssue({
      issueKey: "broker-token:robinhood",
      severity: "critical", category: "broker",
      title: "Robinhood connection expired — reconnect required",
      detail: `Stored Robinhood token expired ${expiry ?? "(unknown)"} and no refresh token is present. Live Robinhood orders, the account snapshot, and holding-risk for all Robinhood accounts will fail until you reconnect in Settings → Robinhood.`,
    }, s);
    return { connected: true, stale: true, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh: false };
  }

  // Token still valid — healthy.
  await resolveIssue("broker-token:robinhood", s);
  return { connected: true, stale: false, expiresAt: expiry, expiresInMs: expMs ? expMs - Date.now() : null, hasRefresh };
}

// ── deterministic MCP JSON-RPC (StreamableHTTP) ───────────────────────────────
// Minimal client: initialize → capture session id → tools/list / tools/call.
// Parses both plain-JSON and text/event-stream responses.
function parseMcpBody(text: string, contentType: string): any {
  if (contentType.includes("text/event-stream")) {
    // Concatenate `data:` lines; take the last JSON object seen.
    let last: any = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m && m[1].trim()) { try { last = JSON.parse(m[1]); } catch { /* skip */ } }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// `sent` distinguishes a request the server DEFINITELY rejected (order not
// placed — safe to fail plainly) from one that was transmitted but whose outcome
// is ambiguous (HTTP 5xx after send, unparseable/empty body, id mismatch,
// missing result). For a place_equity_order call the ambiguous case MUST become
// needsReconcile, never a plain failure that can be auto-resubmitted (double
// order). Definite rejections = a JSON-RPC `error` object or tools/call
// `result.isError` — the server processed and refused, so nothing was placed.
async function mcpRpc(token: string, method: string, params: any, sessionId?: string, isNotification = false): Promise<{ ok: boolean; result?: any; error?: string; sessionId?: string; sent?: boolean }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const reqId = b64url(randomBytes(8));
  const body: any = { jsonrpc: "2.0", method, ...(isNotification ? {} : { id: reqId }), ...(params !== undefined ? { params } : {}) };
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const sid = res.headers.get("mcp-session-id") ?? sessionId;
  if (isNotification) return { ok: res.ok, sessionId: sid ?? undefined };
  const text = await res.text();
  const parsed = parseMcpBody(text, res.headers.get("content-type") ?? "");
  // Ambiguous (request reached the server, outcome unconfirmable) → sent:true.
  if (!res.ok) return { ok: false, sent: true, error: `MCP ${method} HTTP ${res.status}: ${text.slice(0, 300)}`, sessionId: sid ?? undefined };
  if (!parsed) return { ok: false, sent: true, error: `MCP ${method}: empty/unparseable response`, sessionId: sid ?? undefined };
  // Definite server-side rejection → sent:false (order was NOT placed).
  if (parsed.error) return { ok: false, sent: false, error: `MCP ${method} error: ${JSON.stringify(parsed.error).slice(0, 300)}`, sessionId: sid ?? undefined };
  // JSON-RPC id must echo the request id — a mismatch means we may have read a
  // stale/other message off the SSE stream; the real outcome is unknown → sent:true.
  if (parsed.id !== undefined && parsed.id !== reqId) return { ok: false, sent: true, error: `MCP ${method}: response id mismatch`, sessionId: sid ?? undefined };
  if (!("result" in parsed)) return { ok: false, sent: true, error: `MCP ${method}: response missing result`, sessionId: sid ?? undefined };
  // tools/call failure reported via result.isError = the tool ran and refused → sent:false.
  if (method === "tools/call" && parsed.result?.isError === true) {
    return { ok: false, sent: false, error: `MCP tool error: ${JSON.stringify(parsed.result?.content ?? parsed.result).slice(0, 300)}`, sessionId: sid ?? undefined };
  }
  return { ok: true, sent: true, result: parsed.result, sessionId: sid ?? undefined };
}

async function openSession(token: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const init = await mcpRpc(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kairos-financeos", version: "1.0" },
  });
  if (!init.ok) return { ok: false, error: init.error };
  // Best-effort initialized notification (some servers require it before tools).
  await mcpRpc(token, "notifications/initialized", undefined, init.sessionId, true).catch(() => {});
  return { ok: true, sessionId: init.sessionId };
}

async function listTools(token: string, sessionId?: string): Promise<{ ok: boolean; tools?: any[]; error?: string }> {
  const r = await mcpRpc(token, "tools/list", {}, sessionId);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, tools: r.result?.tools ?? [] };
}

// Map our canonical order fields onto a discovered tool's inputSchema property
// names. FAIL CLOSED: if a required schema property can't be confidently
// filled, return null so the caller aborts rather than sending a guessed
// real-money payload.
function buildArgsFromSchema(schema: any, canonical: Record<string, any>): Record<string, any> | { __error: string } {
  const props = schema?.properties ?? {};
  const required: string[] = schema?.required ?? [];
  // Deliberately NARROW aliases. Notably `qty` does NOT map to `amount` —
  // `amount` on many broker APIs means DOLLAR notional, not share count, so
  // mapping 10 shares → amount:10 could place a $10 order. If the schema only
  // offers a dollar-notional field, we fail closed below rather than guess.
  const alias: Record<string, string[]> = {
    symbol: ["symbol", "ticker", "instrument", "instrument_symbol"],
    side: ["side", "transaction_type", "direction"],
    qty: ["quantity", "qty", "shares"],
    type: ["order_type", "type"],
    limitPrice: ["limit_price", "price"],
    account: ["account_number", "account", "account_id"],
    timeInForce: ["time_in_force", "tif"],
  };
  const out: Record<string, any> = {};
  for (const [canonKey, names] of Object.entries(alias)) {
    let v = canonical[canonKey];
    if (v === undefined || v === null) continue;
    const hit = names.find(n => n in props);
    if (!hit) continue;
    // Coerce enum-valued fields to whatever the schema's enum spells (BUY vs
    // buy vs B), instead of assuming lowercase. If the schema declares an enum
    // and none of our candidate spellings match, fail closed.
    if (canonKey === "side") {
      const coerced = coerceEnum(props[hit], v === "buy" ? ["buy", "BUY", "B", "Buy"] : ["sell", "SELL", "S", "Sell"]);
      if (coerced === undefined) return { __error: `side enum not resolvable against schema for '${hit}' (enum=${JSON.stringify(props[hit]?.enum)})` };
      v = coerced;
    } else if (canonKey === "type") {
      const coerced = coerceEnum(props[hit], v === "limit" ? ["limit", "LIMIT", "Limit"] : ["market", "MARKET", "Market"]);
      if (coerced === undefined) return { __error: `order_type enum not resolvable against schema for '${hit}'` };
      v = coerced;
    } else if (canonKey === "timeInForce") {
      const coerced = coerceEnum(props[hit], ["gfd", "GFD", "day", "DAY", "gtc", "GTC"]);
      // Fail closed like side/type: if the schema declares a tif enum and none
      // of our spellings match, skip the field rather than send a raw value the
      // server may reject or misinterpret (unless it's a required field, in
      // which case the missing-required check below aborts the order).
      if (coerced === undefined) continue;
      v = coerced;
    }
    // Coerce to the schema's DECLARED json type. Robinhood's schema wants some
    // numeric-looking fields (e.g. quantity) as STRINGS — sending a raw number
    // is rejected ("has type integer, want string"). Cast per props[hit].type.
    // `type` can be a string OR an array (e.g. ["string","null"]).
    const rawType = props[hit]?.type;
    const declType: string | undefined = Array.isArray(rawType)
      ? rawType.find((t: string) => t !== "null")
      : rawType;
    if (declType === "string") v = typeof v === "string" ? v : String(v);
    else if (declType === "integer") v = Math.trunc(Number(v));
    else if (declType === "number") v = Number(v);
    else if (declType === "boolean") v = Boolean(v);
    out[hit] = v;
  }
  const missing = required.filter(r => !(r in out));
  if (missing.length) {
    return { __error: `cannot fill required order fields ${JSON.stringify(missing)} from schema ${JSON.stringify(Object.keys(props))} — refusing to guess a real order (do NOT map share qty onto a dollar-amount field)` };
  }
  return out;
}

// If the schema property declares an enum, return the first candidate that is
// actually in that enum (so we send the exact spelling the server expects). If
// there is no enum, return the first candidate as-is. undefined = no match.
function coerceEnum(prop: any, candidates: string[]): string | undefined {
  const en: string[] | undefined = prop?.enum;
  if (Array.isArray(en) && en.length) return candidates.find(c => en.includes(c));
  return candidates[0];
}

export interface RobinhoodOrderInput { account: string; symbol: string; side: "buy" | "sell"; qty: number; type: "market" | "limit"; limitPrice?: number }
export interface RobinhoodOrderResult { ok: boolean; brokerOrderId?: string; raw?: any; error?: string; needsReconcile?: boolean }

// Deterministic review → place. No LLM. Discovers tool arg schemas at runtime
// and fails closed rather than guessing. On an ambiguous post-place failure
// (possible success), returns needsReconcile so the caller never auto-resubmits.
export async function submitRobinhoodOrder(o: RobinhoodOrderInput): Promise<RobinhoodOrderResult> {
  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc);
  if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "not connected" };

  const sess = await openSession(tk.token);
  if (!sess.ok) return { ok: false, error: sess.error };
  const sid = sess.sessionId;

  const tl = await listTools(tk.token, sid);
  if (!tl.ok) return { ok: false, error: tl.error };
  const tools = tl.tools ?? [];
  const reviewTool = tools.find(t => t.name === "review_equity_order");
  const placeTool = tools.find(t => t.name === "place_equity_order");
  if (!placeTool) return { ok: false, error: "place_equity_order not offered by the Robinhood MCP server" };

  const canonical = {
    account: o.account, symbol: o.symbol, side: o.side, qty: o.qty,
    type: o.type, limitPrice: o.limitPrice, timeInForce: "gfd",
  };

  // Review first (if the server exposes it) — never send an order we couldn't
  // review, and verify the broker's preview ECHOES the exact order we intend.
  // A review that comes back with a different symbol/side/qty means our schema
  // mapping is wrong (e.g. a dollar-amount field) — abort rather than place.
  if (reviewTool) {
    const rArgs = buildArgsFromSchema(reviewTool.inputSchema, canonical);
    if ("__error" in rArgs) return { ok: false, error: `review: ${rArgs.__error}` };
    const review = await mcpRpc(tk.token, "tools/call", { name: "review_equity_order", arguments: rArgs }, sid);
    if (!review.ok) return { ok: false, error: `review_equity_order failed: ${review.error}` };
    const echo = reviewEchoMismatch(review.result?.content ?? review.result, o);
    if (echo) return { ok: false, error: `review preview did not match the intended order (${echo}) — refusing to place` };
  }

  const pArgs = buildArgsFromSchema(placeTool.inputSchema, canonical);
  if ("__error" in pArgs) return { ok: false, error: `place: ${pArgs.__error}` };
  // Account MUST be pinned to the wire args. buildArgsFromSchema silently drops
  // account if the schema has no account property; a place with no account lets
  // the server pick a default account. Fail closed if we intended an account
  // but none landed in the payload.
  if (canonical.account && !["account_number", "account", "account_id"].some(k => k in (pArgs as Record<string, any>))) {
    return { ok: false, error: "place: account could not be pinned to order args (schema has no account field) — refusing to place on an unspecified account" };
  }

  let place;
  try {
    place = await mcpRpc(tk.token, "tools/call", { name: "place_equity_order", arguments: pArgs }, sid);
  } catch (e) {
    // Timed out AFTER possibly placing — never auto-resubmit; force reconcile.
    return { ok: false, needsReconcile: true, error: `place ambiguous (possible success): ${String(e)} — reconcile via get_equity_orders before any retry` };
  }
  if (!place.ok) {
    // A transmitted-but-ambiguous failure (5xx after send, unparseable body, id
    // mismatch) may have placed the order — force reconcile, never plain-fail
    // (plain failure → status 'error' → resubmittable → double order). Only a
    // definite server rejection (sent:false) is safe to fail plainly.
    if (place.sent) return { ok: false, needsReconcile: true, error: `place ambiguous (possible success): ${place.error} — reconcile via get_equity_orders before any retry` };
    return { ok: false, error: `place_equity_order rejected: ${place.error}` };
  }
  const content = place.result?.content ?? place.result;
  const brokerOrderId = extractOrderId(content);
  // A "success" with no parseable order id can't be tracked/reconciled — treat
  // it as ambiguous, not success, so it isn't blindly retried.
  if (!brokerOrderId) {
    return { ok: false, needsReconcile: true, raw: redact(content), error: "place response had no parseable order id — reconcile via get_equity_orders before any retry" };
  }
  return { ok: true, brokerOrderId, raw: redact(content) };
}

// Returns a human-readable mismatch string if the review preview does not match
// the intended order; null if consistent. A wrong-side/wrong-account/wrong-qty
// preview that passed silently = a real WRONG order, so this checks side,
// account, symbol, qty, and type. Prefers structured JSON; falls back to a text
// scan. A field ABSENT from an opaque preview is not hard-failed, but a
// PRESENT-and-WRONG value aborts the place.
function reviewEchoMismatch(content: any, o: RobinhoodOrderInput): string | null {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parsed = mcpToolJson(content);
  // Flatten a possibly-nested preview object to search for known fields.
  const flat: Record<string, any> = {};
  const walk = (obj: any) => {
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object") walk(v);
        else flat[k.toLowerCase()] = v;
      }
    }
  };
  if (parsed) walk(parsed);

  // Structured checks (only when the field is actually present).
  const sideField = flat["side"] ?? flat["transaction_type"] ?? flat["direction"];
  if (sideField != null && !String(sideField).toLowerCase().includes(o.side)) {
    return `side ${o.side} != preview ${sideField}`;
  }
  const acctField = flat["account_number"] ?? flat["account"] ?? flat["account_id"];
  if (acctField != null && o.account && !String(acctField).includes(o.account)) {
    return `account ${o.account} != preview ${acctField}`;
  }
  const typeField = flat["order_type"] ?? flat["type"];
  if (typeField != null && o.type && !String(typeField).toLowerCase().includes(o.type)) {
    return `type ${o.type} != preview ${typeField}`;
  }

  // Text fallback (covers opaque/string previews).
  const s = (typeof content === "string" ? content : JSON.stringify(content ?? "")).toUpperCase();
  if (!s) return null;
  // symbol: word-boundary match so "A" doesn't match "AAPL".
  if (s.includes("SYMBOL") && !new RegExp(`\\b${esc(o.symbol.toUpperCase())}\\b`).test(s)) return `symbol ${o.symbol} not in preview`;
  // side: if the opposite side word appears and ours does not, abort.
  if (sideField == null) {
    const wantSide = o.side.toUpperCase();
    const otherSide = o.side === "buy" ? "SELL" : "BUY";
    if (new RegExp(`\\b${otherSide}\\b`).test(s) && !new RegExp(`\\b${wantSide}\\b`).test(s)) return `side ${o.side} not in preview (found ${otherSide})`;
  }
  // qty: if a quantity field is present, require our exact integer.
  const qtyM = s.match(/"?(?:QUANTITY|QTY|SHARES)"?\s*[:=]\s*"?(\d+(?:\.\d+)?)"?/);
  if (qtyM && Math.trunc(Number(qtyM[1])) !== Math.trunc(o.qty)) return `qty ${o.qty} != preview ${qtyM[1]}`;
  return null;
}

// MCP tool results come back as [{type:"text", text:"<JSON string>"}]. Pull the
// text payload(s) and parse the embedded JSON if possible.
function mcpToolText(content: any): string {
  if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c))).join("\n");
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}
function mcpToolJson(content: any): any {
  const text = mcpToolText(content);
  try { return JSON.parse(text); } catch { /* not a clean JSON string */ }
  return null;
}

function extractOrderId(content: any): string | undefined {
  try {
    const obj = mcpToolJson(content);
    const nested = obj?.data?.order?.id ?? obj?.order?.id ?? obj?.data?.id ?? obj?.id;
    if (typeof nested === "string" && nested.length >= 8) return nested;
    // Fallback regex on the (possibly escaped) text. Prefer an explicit
    // order_id key first — a bare "id" could be an instrument/account/request
    // id embedded earlier in the payload. Only fall back to a bare "id" if it
    // appears exactly once AND is UUID-shaped, to avoid grabbing the wrong id
    // (which would brick reconciliation or copy another order's fill state).
    const un = mcpToolText(content).replace(/\\"/g, '"');
    const orderM = un.match(/"order[_-]?id"\s*:\s*"([0-9A-Za-z-]{8,})"/i);
    if (orderM) return orderM[1];
    const uuidRe = /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/ig;
    const uuids = [...un.matchAll(uuidRe)];
    if (uuids.length === 1) return uuids[0][1];
    return undefined;
  } catch { return undefined; }
}

export { mcpToolText, mcpToolJson };
// Strip anything token-shaped before persisting or logging a raw payload —
// both `Bearer <tok>` headers and raw access/refresh_token JSON fields.
function redact(v: any): any {
  try {
    return JSON.parse(redactStr(JSON.stringify(v)));
  } catch { return null; }
}
function redactStr(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, "$1[redacted]")
    .replace(/("(?:access|refresh)_token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2");
}

// Read-only account snapshot via MCP (get_accounts + get_equity_positions + get_portfolio).
// get_accounts returns only account metadata; the live NAV (data.total_value) lives in
// get_portfolio, which requires the account's rhs_account_number. account param = the
// trading account to price; when omitted, the agentic-allowed account is used.
export async function queryRobinhoodAccount(account?: string): Promise<{ ok: boolean; error?: string; data?: any }> {
  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc);
  if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "not connected" };
  const sess = await openSession(tk.token);
  if (!sess.ok) return { ok: false, error: sess.error };
  const accounts = await mcpRpc(tk.token, "tools/call", { name: "get_accounts", arguments: {} }, sess.sessionId);
  if (!accounts.ok) return { ok: false, error: `get_accounts failed: ${accounts.error}` };

  // Resolve which account to price/hold: the requested trading account if present in the
  // list, else the agentic-allowed account, else the first. get_portfolio AND
  // get_equity_positions are account-scoped — a bare call returns the default account,
  // which is why the agentic account's NAV/positions came back empty.
  const acctList = (() => {
    const o = mcpToolJson(accounts.result?.content ?? accounts.result);
    return o?.data?.accounts ?? o?.accounts ?? [];
  })();
  // Resolve the account to price. If an explicit account was requested it MUST match
  // exactly — never fall back to another account, or we'd store wrong-account NAV/positions
  // under the requested id and feed the G3 gate a wrong live book. Match on either
  // account_number or rhs_account_number.
  let acctFor: string | undefined;
  if (account) {
    const match = acctList.find((a: any) => String(a.rhs_account_number) === account || String(a.account_number) === account);
    if (!match) return { ok: false, error: `requested account ${account} not found in the Robinhood account list — refusing to snapshot a different account` };
    acctFor = String(match.rhs_account_number);
  } else {
    acctFor = acctList.find((a: any) => a.agentic_allowed)?.rhs_account_number ?? acctList[0]?.rhs_account_number;
  }

  const positions = await mcpRpc(tk.token, "tools/call", { name: "get_equity_positions", arguments: acctFor ? { account_number: acctFor } : {} }, sess.sessionId);
  if (!positions.ok) return { ok: false, error: `get_equity_positions failed: ${positions.error}` };
  const portfolio = acctFor
    ? await mcpRpc(tk.token, "tools/call", { name: "get_portfolio", arguments: { account_number: acctFor } }, sess.sessionId).catch(() => ({ result: null }))
    : { result: null };

  if (acctFor && !(portfolio as any)?.ok) {
    return { ok: false, error: `get_portfolio failed: ${(portfolio as any)?.error ?? "unknown MCP error"}` };
  }

  return { ok: true, data: { accounts: accounts.result, positions: positions.result, portfolio: (portfolio as any)?.result ?? null } };
}

// Read every investing account visible to the owner's Robinhood MCP connection.
// This primitive is read-only and never invokes review/place/cancel tools. Missing
// prices fail the affected account closed so risk analytics cannot quietly treat
// cost basis as a current quote.
export async function captureAllRobinhoodAccounts(): Promise<BrokerAccount[]> {
  const fetchedAt = new Date().toISOString();
  const errorStub = (error: string, accountId = "unknown", accountLabel = "Robinhood"): BrokerAccount => ({
    source: "robinhood", accountId, accountLabel, totalValue: 0, cashBalance: 0,
    holdings: [], fetchedAt, error,
  });

  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc);
  if (!tk.ok || !tk.token) return [errorStub(tk.error ?? "Robinhood MCP is not connected")];
  const sess = await openSession(tk.token);
  if (!sess.ok) return [errorStub(sess.error ?? "Robinhood MCP session failed")];
  const sid = sess.sessionId;

  const accountResult: Awaited<ReturnType<typeof mcpRpc>> = await mcpRpc(tk.token, "tools/call", { name: "get_accounts", arguments: {} }, sid)
    .catch((e) => ({ ok: false, error: String(e) }));
  if (!accountResult.ok) return [errorStub(`get_accounts failed: ${accountResult.error}`)];
  const accountObject = mcpToolJson(accountResult.result?.content ?? accountResult.result);
  const rawAccounts: any[] = Array.isArray(accountObject?.data?.accounts) ? accountObject.data.accounts
    : Array.isArray(accountObject?.accounts) ? accountObject.accounts : [];
  if (!rawAccounts.length) return [errorStub("Robinhood MCP returned no accounts")];

  const { brokerAccountDisplayLabel, brokerAccountKey, loadLatestBrokerNicknames } = await import("@/lib/brokers/account-label");
  const rawIdentities = rawAccounts.map((raw: any) => ({
    broker: "robinhood",
    accountId: String(raw?.account_number ?? raw?.rhs_account_number ?? raw?.id ?? "").trim(),
  })).filter((identity: { accountId: string }) => identity.accountId);
  const nicknames = await loadLatestBrokerNicknames(svc, rawIdentities);
  const labelFor = (id: string) => brokerAccountDisplayLabel({
    broker: "robinhood",
    accountId: id,
    nickname: nicknames.get(brokerAccountKey("robinhood", id)),
  });

  type Captured = { id: string; wireId: string; positions?: any[]; portfolio?: any; error?: string };
  const captured: Captured[] = [];
  // Limit concurrency to two accounts to avoid a 12-call burst while keeping the
  // capture inside the serverless route's normal execution window.
  for (let i = 0; i < rawAccounts.length; i += 2) {
    const rows = await Promise.all(rawAccounts.slice(i, i + 2).map(async (raw): Promise<Captured> => {
      // account_number is the stable/user-facing identity (and may be
      // alphanumeric); rhs_account_number is what account-scoped MCP tools need.
      const id = String(raw?.account_number ?? raw?.rhs_account_number ?? raw?.id ?? "").trim();
      const wireId = String(raw?.rhs_account_number ?? raw?.account_number ?? raw?.id ?? "").trim();
      if (!id || !wireId) return { id: "unknown", wireId: "unknown", error: "account response omitted an account number" };
      try {
        const [posResult, portResult] = await Promise.all([
          mcpRpc(tk.token!, "tools/call", { name: "get_equity_positions", arguments: { account_number: wireId } }, sid),
          mcpRpc(tk.token!, "tools/call", { name: "get_portfolio", arguments: { account_number: wireId } }, sid),
        ]);
        if (!posResult.ok) return { id, wireId, error: `get_equity_positions failed: ${posResult.error}` };
        if (!portResult.ok) return { id, wireId, error: `get_portfolio failed: ${portResult.error}` };
        const posObject = mcpToolJson(posResult.result?.content ?? posResult.result);
        const portObject = mcpToolJson(portResult.result?.content ?? portResult.result);
        const posData = posObject?.data ?? posObject;
        const positions = Array.isArray(posData?.positions) ? posData.positions
          : Array.isArray(posData?.results) ? posData.results
          : Array.isArray(posData) ? posData : null;
        if (!positions) return { id, wireId, error: "get_equity_positions returned an unparseable payload" };
        if (!portObject) return { id, wireId, error: "get_portfolio returned an unparseable payload" };
        return { id, wireId, positions, portfolio: portObject?.data ?? portObject };
      } catch (e) {
        return { id, wireId, error: `Robinhood MCP account capture failed: ${String(e)}` };
      }
    }));
    captured.push(...rows);
  }

  const symbols = Array.from(new Set(captured.flatMap(a => (a.positions ?? []).map(p =>
    String(p?.symbol ?? p?.instrument?.symbol ?? "").trim().toUpperCase(),
  )).filter(Boolean)));
  const prices = new Map<string, number>();
  let quoteError: string | undefined;
  if (symbols.length) {
    const toolList = await listTools(tk.token, sid);
    const quoteTool = toolList.tools?.find(t => t.name === "get_equity_quotes");
    if (!toolList.ok || !quoteTool) {
      quoteError = toolList.error ?? "get_equity_quotes is not offered by Robinhood MCP";
    } else {
      const props = quoteTool.inputSchema?.properties ?? {};
      const symbolKey = ["symbols", "symbol", "tickers"].find(k => k in props) ?? "symbols";
      for (let i = 0; i < symbols.length; i += 20) {
        const batch = symbols.slice(i, i + 20);
        const rawType = props[symbolKey]?.type;
        const declaredType = Array.isArray(rawType) ? rawType.find((t: string) => t !== "null") : rawType;
        const symbolValue = declaredType === "string" ? batch.join(",") : batch;
        try {
          const qr = await mcpRpc(tk.token, "tools/call", {
            name: "get_equity_quotes", arguments: { [symbolKey]: symbolValue },
          }, sid);
          if (!qr.ok) { quoteError = qr.error ?? "get_equity_quotes failed"; break; }
          const qo = mcpToolJson(qr.result?.content ?? qr.result);
          const qd = qo?.data ?? qo;
          const quotes: any[] = Array.isArray(qd?.quotes) ? qd.quotes
            : Array.isArray(qd?.results) ? qd.results : Array.isArray(qd) ? qd : [];
          if (!quotes.length) quoteError = "get_equity_quotes returned an unparseable payload";
          for (const q of quotes) {
            // Robinhood currently wraps each record as { quote: {...} }.
            const quote = q?.quote ?? q;
            const symbol = String(quote?.symbol ?? quote?.instrument?.symbol ?? "").trim().toUpperCase();
            const price = Number(quote?.last_extended_hours_trade_price ?? quote?.last_trade_price
              ?? quote?.current_price ?? quote?.last_price ?? quote?.mark_price ?? quote?.price);
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
      const symbol = String(p?.symbol ?? p?.instrument?.symbol ?? "").trim().toUpperCase();
      const qty = Number(p?.quantity ?? p?.qty ?? p?.shares ?? 0);
      if (!symbol || !Number.isFinite(qty) || qty <= 0) continue;
      const averageCost = Number(p?.average_buy_price ?? p?.average_price ?? p?.avg_price ?? p?.avg_cost ?? 0);
      const currentPrice = prices.get(symbol);
      if (!currentPrice) { missingQuotes.push(symbol); continue; }
      const marketValue = qty * currentPrice;
      const costBasis = Number.isFinite(averageCost) && averageCost >= 0 ? qty * averageCost : undefined;
      holdings.push({
        symbol, qty, currentPrice, marketValue, costBasis,
        unrealizedPnl: costBasis == null ? undefined : marketValue - costBasis,
        unrealizedPnlPct: costBasis != null && costBasis > 0 ? ((marketValue - costBasis) / costBasis) * 100 : undefined,
        side: "long", source: "robinhood",
      });
    }
    if (missingQuotes.length) {
      const suffix = quoteError ? ` (${quoteError})` : "";
      return errorStub(`Current quote unavailable for ${missingQuotes.join(", ")}${suffix}`, a.id, label);
    }
    const portfolio = a.portfolio ?? {};
    const totalValue = Number(portfolio?.total_value ?? portfolio?.portfolio_value ?? portfolio?.equity);
    const cashBalance = Number(portfolio?.cash ?? portfolio?.cash_balance
      ?? portfolio?.buying_power?.cash_available_for_withdrawal ?? 0);
    const buyingPower = Number(portfolio?.buying_power?.buying_power ?? portfolio?.buying_power ?? 0);
    if (!Number.isFinite(totalValue) || totalValue < 0) {
      return errorStub("get_portfolio omitted a valid total_value", a.id, label);
    }
    return {
      source: "robinhood", accountId: a.id, accountLabel: label, totalValue,
      cashBalance: Number.isFinite(cashBalance) && cashBalance >= 0 ? cashBalance : 0,
      // Robinhood account types do not all expose the same buying_power shape.
      // For cash accounts, MCP `cash` is the conservative available-funds value;
      // use it when the nested buying_power scalar is absent/unparseable.
      buyingPower: Number.isFinite(buyingPower) && buyingPower >= 0
        ? buyingPower
        : (Number.isFinite(cashBalance) && cashBalance >= 0 ? cashBalance : undefined),
      holdings, fetchedAt,
    };
  });
}

// Held share quantity for a symbol on the live Robinhood account, fetched
// fresh via MCP. Used by the Execution Gateway to gate SELLs against the ACTUAL
// account that will trade (not the cached read-only snapshot).
// account param: the active trading account number — positions filtered to that
// account when the parsed JSON includes account-level metadata.
// Returns:
//   { ok:true, qty:number }  — parsed a definite position quantity (0 = none)
//   { ok:false }             — could not determine → caller must fail closed
export async function robinhoodHeldQty(symbol: string, account?: string): Promise<{ ok: boolean; qty?: number; error?: string }> {
  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc);
  if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "not connected" };
  const sess = await openSession(tk.token);
  if (!sess.ok) return { ok: false, error: sess.error };
  // get_equity_positions is ACCOUNT-SCOPED — a bare {} call returns the default account,
  // not the agentic trading account, so the SELL held-check must pass account_number.
  const res = await mcpRpc(tk.token, "tools/call", { name: "get_equity_positions", arguments: account ? { account_number: account } : {} }, sess.sessionId);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const content = res.result?.content ?? res.result;
    const sym = symbol.toUpperCase();

    // Prefer structured JSON parse (handles Robinhood MCP escaped text content).
    const parsed = mcpToolJson(content);
    if (parsed) {
      const positions: any[] =
        Array.isArray(parsed?.positions) ? parsed.positions
        : Array.isArray(parsed?.results) ? parsed.results
        : Array.isArray(parsed) ? parsed
        : [];
      const hasAcctMeta = positions.some((p: any) => p.account != null || p.account_number != null || p.account_id != null);
      const filtered = account
        ? positions.filter((p: any) =>
            String(p.account ?? p.account_number ?? p.account_id ?? "").includes(account))
        : positions;
      // When an account was specified AND positions carry account metadata but
      // NONE match, do NOT fall back to all positions — that would let shares on
      // the read-only account satisfy a SELL gate for the trading account.
      // Report 0 held (fail-closed for the sell gate).
      if (account && hasAcctMeta && filtered.length === 0) return { ok: true, qty: 0 };
      const pool = filtered.length > 0 ? filtered : positions;
      const pos = pool.find((p: any) => {
        const s = String(p.symbol ?? p.instrument_id ?? "").toUpperCase();
        return s === sym || s.startsWith(sym + "/");
      });
      if (!pos) return { ok: true, qty: 0 };
      const qty = parseFloat(pos.quantity ?? pos.qty ?? pos.shares ?? "0");
      return Number.isFinite(qty) ? { ok: true, qty } : { ok: false, error: "position found but quantity non-finite" };
    }

    // Regex fallback on raw text — less safe, but preserves prior behavior when
    // JSON parse fails (e.g. Robinhood returns plain text).
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    if (!text.toUpperCase().includes(sym)) return { ok: true, qty: 0 };
    // Escape regex metachars in the symbol — SYMBOL_RE allows '.' (e.g. BRK.B),
    // which unescaped would match any char and could read the wrong row.
    const symRe = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${symRe}["'\\s\\S]{0,120}?"?(?:quantity|qty|shares)"?\\s*[:=]\\s*"?(\\d+(?:\\.\\d+)?)`, "i");
    const m = text.match(re);
    if (!m) return { ok: false, error: "symbol present but quantity unparseable" };
    return { ok: true, qty: Number(m[1]) };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Order-status query for the sync loop. Deterministic (no LLM): calls
// get_equity_orders, finds the order by id, and maps Robinhood's `state` to the
// adapter's status union. Returns ok:false (never guesses) if the order isn't in
// the response or the state is unmapped, so the sync loop leaves the row untouched.
type RhOrderStatus = "submitted" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired";
function mapRhOrderState(state: string): RhOrderStatus | undefined {
  const s = state.toLowerCase();
  if (s === "filled") return "filled";
  if (s === "partially_filled" || s === "partial") return "partially_filled";
  if (s === "cancelled" || s === "canceled") return "canceled";
  if (s === "rejected" || s === "failed") return "rejected";
  if (s === "expired") return "expired";
  if (["unconfirmed", "confirmed", "queued", "pending", "new", "open", "accepted"].includes(s)) return "submitted";
  return undefined;
}
function finiteNum(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function queryRobinhoodOrder(brokerOrderId: string): Promise<{
  ok: boolean; error?: string; status?: RhOrderStatus; filledQty?: number; avgFillPrice?: number; raw?: any;
}> {
  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc);
  if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "not connected" };
  const sess = await openSession(tk.token);
  if (!sess.ok) return { ok: false, error: sess.error };
  const res = await mcpRpc(tk.token, "tools/call", { name: "get_equity_orders", arguments: {} }, sess.sessionId);
  if (!res.ok) return { ok: false, error: res.error };

  const content = res.result?.content ?? res.result;
  const obj = mcpToolJson(content);
  const list: any[] = Array.isArray(obj) ? obj
    : (obj?.data?.orders ?? obj?.orders ?? obj?.data?.results ?? obj?.results ?? (Array.isArray(obj?.data) ? obj.data : []));
  const order = Array.isArray(list)
    ? list.find((o: any) => String(o?.id ?? o?.order?.id ?? "") === brokerOrderId)
    : null;
  if (!order) return { ok: false, error: "order not found in get_equity_orders response (may be outside the returned window)" };

  const state = String(order.state ?? order.status ?? "");
  const status = mapRhOrderState(state);
  if (!status) return { ok: false, error: `unmapped Robinhood order state '${state}'` };
  const filledQty = finiteNum(order.cumulative_quantity ?? order.filled_quantity ?? order.filled_qty ?? (status === "filled" ? order.quantity : undefined));
  const avgFillPrice = finiteNum(order.average_price ?? order.avg_fill_price ?? order.executed_price ?? order.price);
  return { ok: true, status, filledQty, avgFillPrice, raw: redact(order) };
}

// Cancel an open order by broker order id. Robinhood's MCP tool is account-scoped,
// so callers must supply the pre-validated trading account. Same mcpRpc pattern as
// queryRobinhoodOrder.
// Race note: Robinhood may fill the order before the cancel reaches it — ok:false with
// a tool error in that case. The reconcile step handles fill-vs-cancel races.
export async function cancelRobinhoodOrder(brokerOrderId: string, account: string): Promise<{ ok: boolean; error?: string; raw?: any }> {
  if (!account.trim()) return { ok: false, error: "account_number is required for Robinhood order cancellation" };
  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc);
  if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "not connected" };
  const sess = await openSession(tk.token);
  if (!sess.ok) return { ok: false, error: sess.error };
  const res = await mcpRpc(tk.token, "tools/call", {
    name: "cancel_equity_order",
    arguments: { order_id: brokerOrderId, account_number: account },
  }, sess.sessionId);
  if (!res.ok) return { ok: false, error: res.error, raw: redact(res.result) };
  return { ok: true, raw: redact(res.result) };
}

// Kill switch: wipe local tokens regardless of remote reachability. (The
// metadata exposes no revocation_endpoint, so there is no remote revoke to
// call — Robinhood's own Agentic Trading dashboard is the authoritative revoke.)
export async function disconnectRobinhoodMcp(svc?: any): Promise<{ ok: boolean; error?: string }> {
  const s = svc ?? createServiceClient();
  const { error } = await vaultDel(s, [VK.access, VK.refresh, VK.expiry]);
  return { ok: !error, error };
}
