import { createServiceClient } from "@/lib/supabase/service";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

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
  await svc.from("api_key_vault").upsert({ key_name: key, key_value: value }, { onConflict: "key_name" });
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
  return process.env.OAUTH_STATE_SECRET ?? process.env.CRON_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "insecure-dev-fallback";
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
    if (!res.ok || !json?.client_id) return { ok: false, error: `registration failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}` };
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
  if (tok.access_token) await vaultSet(svc, VK.access, tok.access_token);
  if (tok.refresh_token) await vaultSet(svc, VK.refresh, tok.refresh_token);
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
    if (!res.ok || !json?.access_token) return { ok: false, error: `token exchange failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}` };
    await storeTokens(svc, json);
    return { ok: true };
  } catch (e) { return { ok: false, error: `token exchange error: ${String(e)}` }; }
}

// Single-writer refresh: re-read the expiry after acquiring, and only refresh if
// still stale (compare-and-swap on the vault's updated_at guards against two
// concurrent refreshers racing and one persisting a dead rotated token).
async function refreshAccessToken(svc: any): Promise<{ ok: boolean; error?: string }> {
  const clientId = await vaultGet(svc, VK.clientId);
  const refresh = await vaultGet(svc, VK.refresh);
  if (!clientId || !refresh) return { ok: false, error: "no refresh token" };
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

async function getValidAccessToken(svc: any): Promise<{ ok: boolean; token?: string; error?: string }> {
  const token = await vaultGet(svc, VK.access);
  if (!token) return { ok: false, error: "not connected" };
  const expiry = await vaultGet(svc, VK.expiry);
  const expMs = expiry ? Date.parse(expiry) : 0;
  if (expMs && Date.now() > expMs - 60_000) {
    const r = await refreshAccessToken(svc);
    if (!r.ok) return { ok: false, error: r.error };
    const fresh = await vaultGet(svc, VK.access);
    return fresh ? { ok: true, token: fresh } : { ok: false, error: "no token after refresh" };
  }
  return { ok: true, token };
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

async function mcpRpc(token: string, method: string, params: any, sessionId?: string, isNotification = false): Promise<{ ok: boolean; result?: any; error?: string; sessionId?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body: any = { jsonrpc: "2.0", method, ...(isNotification ? {} : { id: b64url(randomBytes(8)) }), ...(params !== undefined ? { params } : {}) };
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const sid = res.headers.get("mcp-session-id") ?? sessionId;
  if (isNotification) return { ok: res.ok, sessionId: sid ?? undefined };
  const text = await res.text();
  const parsed = parseMcpBody(text, res.headers.get("content-type") ?? "");
  if (!res.ok) return { ok: false, error: `MCP ${method} HTTP ${res.status}: ${text.slice(0, 300)}`, sessionId: sid ?? undefined };
  if (parsed?.error) return { ok: false, error: `MCP ${method} error: ${JSON.stringify(parsed.error).slice(0, 300)}`, sessionId: sid ?? undefined };
  return { ok: true, result: parsed?.result, sessionId: sid ?? undefined };
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
  const alias: Record<string, string[]> = {
    symbol: ["symbol", "ticker", "instrument", "instrument_symbol"],
    side: ["side", "transaction_type", "direction"],
    qty: ["quantity", "qty", "shares", "amount"],
    type: ["order_type", "type"],
    limitPrice: ["limit_price", "price"],
    account: ["account_number", "account", "account_id"],
    timeInForce: ["time_in_force", "tif"],
  };
  const out: Record<string, any> = {};
  for (const [canonKey, names] of Object.entries(alias)) {
    if (canonical[canonKey] === undefined || canonical[canonKey] === null) continue;
    const hit = names.find(n => n in props);
    if (hit) out[hit] = canonical[canonKey];
  }
  // Default a required time_in_force if the schema wants one and we didn't set it.
  for (const tifName of ["time_in_force", "tif"]) {
    if (required.includes(tifName) && !(tifName in out)) out[tifName] = "gfd";
  }
  const missing = required.filter(r => !(r in out));
  if (missing.length) {
    return { __error: `cannot fill required order fields ${JSON.stringify(missing)} from schema ${JSON.stringify(Object.keys(props))} — refusing to guess a real order` };
  }
  return out;
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
  // review, and never guess review args either.
  if (reviewTool) {
    const rArgs = buildArgsFromSchema(reviewTool.inputSchema, canonical);
    if ("__error" in rArgs) return { ok: false, error: `review: ${rArgs.__error}` };
    const review = await mcpRpc(tk.token, "tools/call", { name: "review_equity_order", arguments: rArgs }, sid);
    if (!review.ok) return { ok: false, error: `review_equity_order failed: ${review.error}` };
  }

  const pArgs = buildArgsFromSchema(placeTool.inputSchema, canonical);
  if ("__error" in pArgs) return { ok: false, error: `place: ${pArgs.__error}` };

  try {
    const place = await mcpRpc(tk.token, "tools/call", { name: "place_equity_order", arguments: pArgs }, sid);
    if (!place.ok) return { ok: false, error: `place_equity_order failed: ${place.error}` };
    const content = place.result?.content ?? place.result;
    const brokerOrderId = extractOrderId(content);
    return { ok: true, brokerOrderId, raw: redact(content) };
  } catch (e) {
    // Timed out AFTER possibly placing — never auto-resubmit; force reconcile.
    return { ok: false, needsReconcile: true, error: `place ambiguous (possible success): ${String(e)} — reconcile via get_equity_orders before any retry` };
  }
}

function extractOrderId(content: any): string | undefined {
  try {
    const s = typeof content === "string" ? content : JSON.stringify(content);
    const m = s.match(/"(?:order_id|id)"\s*:\s*"([^"]+)"/);
    return m?.[1];
  } catch { return undefined; }
}
// Strip anything token-shaped before persisting a raw payload.
function redact(v: any): any {
  try {
    let s = JSON.stringify(v);
    s = s.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, "$1[redacted]");
    return JSON.parse(s);
  } catch { return null; }
}

// Read-only account snapshot via MCP (get_accounts + get_equity_positions).
export async function queryRobinhoodAccount(): Promise<{ ok: boolean; error?: string; data?: any }> {
  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc);
  if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "not connected" };
  const sess = await openSession(tk.token);
  if (!sess.ok) return { ok: false, error: sess.error };
  const accounts = await mcpRpc(tk.token, "tools/call", { name: "get_accounts", arguments: {} }, sess.sessionId);
  const positions = await mcpRpc(tk.token, "tools/call", { name: "get_equity_positions", arguments: {} }, sess.sessionId);
  return { ok: true, data: { accounts: accounts.result, positions: positions.result } };
}

// Kill switch: wipe local tokens regardless of remote reachability. (The
// metadata exposes no revocation_endpoint, so there is no remote revoke to
// call — Robinhood's own Agentic Trading dashboard is the authoritative revoke.)
export async function disconnectRobinhoodMcp(svc?: any): Promise<{ ok: boolean; error?: string }> {
  const s = svc ?? createServiceClient();
  const { error } = await vaultDel(s, [VK.access, VK.refresh, VK.expiry]);
  return { ok: !error, error };
}
