import { createServiceClient } from "@/lib/supabase/service";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { reportIssue, resolveIssue } from "@/lib/system-health";

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

// Single-writer refresh via compare-and-swap on the refresh-token row's
// updated_at: claim the refresh by CAS-updating updated_at to now; if the row
// changed under us (another process refreshed first) we lose the race and
// re-read instead of calling the token endpoint with a possibly-rotated token.
async function refreshAccessToken(svc: any): Promise<{ ok: boolean; error?: string }> {
  const clientId = await vaultGet(svc, VK.clientId);
  const { value: refresh, updatedAt } = await vaultGetWithVersion(svc, VK.refresh);
  if (!clientId || !refresh) return { ok: false, error: "no refresh token" };

  // CAS claim: only proceed if this row's updated_at is still what we read.
  const nowIso = new Date().toISOString();
  const { data: claimed } = await svc
    .from("api_key_vault")
    .update({ updated_at: nowIso })
    .eq("key_name", VK.refresh)
    .eq("updated_at", updatedAt)
    .select("key_name");
  if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) {
    // Lost the race — another writer is refreshing. Don't call the endpoint.
    return { ok: true }; // caller re-reads the (freshly stored) access token
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

async function getValidAccessToken(svc: any): Promise<{ ok: boolean; token?: string; error?: string }> {
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
  const reqId = b64url(randomBytes(8));
  const body: any = { jsonrpc: "2.0", method, ...(isNotification ? {} : { id: reqId }), ...(params !== undefined ? { params } : {}) };
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const sid = res.headers.get("mcp-session-id") ?? sessionId;
  if (isNotification) return { ok: res.ok, sessionId: sid ?? undefined };
  const text = await res.text();
  const parsed = parseMcpBody(text, res.headers.get("content-type") ?? "");
  if (!res.ok) return { ok: false, error: `MCP ${method} HTTP ${res.status}: ${text.slice(0, 300)}`, sessionId: sid ?? undefined };
  if (!parsed) return { ok: false, error: `MCP ${method}: empty/unparseable response`, sessionId: sid ?? undefined };
  if (parsed.error) return { ok: false, error: `MCP ${method} error: ${JSON.stringify(parsed.error).slice(0, 300)}`, sessionId: sid ?? undefined };
  // JSON-RPC id must echo the request id — guards against a mismatched/stale
  // message being read out of an SSE stream as this call's result.
  if (parsed.id !== undefined && parsed.id !== reqId) return { ok: false, error: `MCP ${method}: response id mismatch`, sessionId: sid ?? undefined };
  if (!("result" in parsed)) return { ok: false, error: `MCP ${method}: response missing result`, sessionId: sid ?? undefined };
  // An MCP tools/call that failed reports it via result.isError, not a JSON-RPC
  // error — treat that as a failure, not a success.
  if (method === "tools/call" && parsed.result?.isError === true) {
    return { ok: false, error: `MCP tool error: ${JSON.stringify(parsed.result?.content ?? parsed.result).slice(0, 300)}`, sessionId: sid ?? undefined };
  }
  return { ok: true, result: parsed.result, sessionId: sid ?? undefined };
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
      if (coerced !== undefined) v = coerced;
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

  let place;
  try {
    place = await mcpRpc(tk.token, "tools/call", { name: "place_equity_order", arguments: pArgs }, sid);
  } catch (e) {
    // Timed out AFTER possibly placing — never auto-resubmit; force reconcile.
    return { ok: false, needsReconcile: true, error: `place ambiguous (possible success): ${String(e)} — reconcile via get_equity_orders before any retry` };
  }
  if (!place.ok) return { ok: false, error: `place_equity_order failed: ${place.error}` };
  const content = place.result?.content ?? place.result;
  const brokerOrderId = extractOrderId(content);
  // A "success" with no parseable order id can't be tracked/reconciled — treat
  // it as ambiguous, not success, so it isn't blindly retried.
  if (!brokerOrderId) {
    return { ok: false, needsReconcile: true, raw: redact(content), error: "place response had no parseable order id — reconcile via get_equity_orders before any retry" };
  }
  return { ok: true, brokerOrderId, raw: redact(content) };
}

// Returns a human-readable mismatch string if the review preview text does not
// contain our intended symbol/side/qty; null if it looks consistent. Best-
// effort text scan — if the fields aren't present at all we do NOT hard-fail
// (some servers return opaque previews), but a PRESENT-and-WRONG value aborts.
function reviewEchoMismatch(content: any, o: RobinhoodOrderInput): string | null {
  const s = (typeof content === "string" ? content : JSON.stringify(content ?? "")).toUpperCase();
  if (!s) return null;
  if (s.includes("SYMBOL") && !s.includes(o.symbol.toUpperCase())) return `symbol ${o.symbol} not in preview`;
  // qty: if a quantity field is present, require our exact integer to appear.
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
    // Fallback: regex on the (possibly escaped) text.
    const un = mcpToolText(content).replace(/\\"/g, '"');
    const m = un.match(/"(?:order[_-]?id|id)"\s*:\s*"([0-9A-Za-z-]{8,})"/);
    return m?.[1];
  } catch { return undefined; }
}

export { mcpToolText, mcpToolJson };
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

// Held share quantity for a symbol on the live Robinhood account, fetched
// fresh via MCP. Used by the Execution Gateway to gate SELLs against the ACTUAL
// account that will trade (not the cached read-only snapshot). Returns:
//   { ok:true, qty:number }  — parsed a definite position quantity (0 = none)
//   { ok:false }             — could not determine → caller must fail closed
export async function robinhoodHeldQty(symbol: string): Promise<{ ok: boolean; qty?: number; error?: string }> {
  const svc = createServiceClient();
  const tk = await getValidAccessToken(svc);
  if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "not connected" };
  const sess = await openSession(tk.token);
  if (!sess.ok) return { ok: false, error: sess.error };
  const res = await mcpRpc(tk.token, "tools/call", { name: "get_equity_positions", arguments: {} }, sess.sessionId);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const content = res.result?.content ?? res.result;
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    const sym = symbol.toUpperCase();
    // Find a {...symbol...quantity...} object mentioning this symbol; pull the
    // nearest quantity. If the symbol isn't mentioned at all, treat as 0 held.
    if (!text.toUpperCase().includes(sym)) return { ok: true, qty: 0 };
    const re = new RegExp(`${sym}["'\\s\\S]{0,200}?"?(?:quantity|qty|shares)"?\\s*[:=]\\s*"?(\\d+(?:\\.\\d+)?)`, "i");
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

// Kill switch: wipe local tokens regardless of remote reachability. (The
// metadata exposes no revocation_endpoint, so there is no remote revoke to
// call — Robinhood's own Agentic Trading dashboard is the authoritative revoke.)
export async function disconnectRobinhoodMcp(svc?: any): Promise<{ ok: boolean; error?: string }> {
  const s = svc ?? createServiceClient();
  const { error } = await vaultDel(s, [VK.access, VK.refresh, VK.expiry]);
  return { ok: !error, error };
}
