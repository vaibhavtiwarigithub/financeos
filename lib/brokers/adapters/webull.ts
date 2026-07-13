import { BrokerAdapter, BrokerOrderResult, BrokerOrderState } from "@/lib/brokers/adapter-types";
import { createServiceClient } from "@/lib/supabase/service";
import { getMcpBroker, McpBrokerConfig } from "@/lib/brokers/mcp-registry";
import { getValidAccessToken, hasToken, mcpRpc, mcpToolJson } from "@/lib/brokers/mcp-driver";

// ============================================================================
// Webull ORDER adapter (Phase 2) — SHIPPED INERT. DO NOT ENABLE WITHOUT A LIVE
// $1 TEST BY THE OWNER.
// ----------------------------------------------------------------------------
// This is money-path code that CANNOT be exercised from the build environment.
// It is deliberately gated OFF at four independent layers (see isConfigured):
//   1. cfg.orderCapable must be true       — config marker, FALSE today.
//   2. cfg.orderTools must be present       — present, but inert without (1).
//   3. a Webull access token must exist     — connected read-only today, but the
//      token was minted with READ-ONLY scopes (no order:write), so a place would
//      be rejected server-side even if (1)/(4) were flipped.
//   4. strategy_config.webull_orders_enabled must be true  — column does NOT
//      exist today → reads fail-closed to FALSE.
//   5. a per-account allowlist row (broker_accounts broker='webull' role=
//      'trading') must exist → NONE today → resolveTradingAccount fails closed.
//
// BEFORE ANY REAL USE the owner MUST, in order:
//   (a) reconnect Webull with orders enabled so the token carries cfg.orderScopes
//       ("... order:read order:write ..."); the current token is read-only.
//   (b) add a strategy_config.webull_orders_enabled boolean column and set it true.
//   (c) allowlist exactly ONE Webull account: insert a broker_accounts row with
//       broker='webull', market='us', role='trading', account_number=<acct>.
//   (d) set cfg.orderCapable = true in lib/brokers/mcp-registry.ts.
//   (e) run a single $1 manual order and reconcile it end-to-end.
// Every existing gate above BrokerAdapter (isTradingEnabled, per-market controls,
// kill switch, notional caps, human confirm) still applies — this adapter never
// bypasses any of them; it only executes once a caller has cleared them.
//
// This adapter is NOT wired into any cron or automated flow. It is reachable only
// through the same execution Gateway the other adapters use, and only once
// registered + gated-on above.
// ============================================================================

function cfgOrNull(): McpBrokerConfig | null {
  const cfg = getMcpBroker("webull");
  return cfg ?? null;
}

export function webullAdapter(): BrokerAdapter {
  return {
    id: "webull",
    market: "us",
    envs: ["live"], // Webull MCP has no paper env.

    // Fail-CLOSED gate. Returns true ONLY when every order-enable condition holds.
    // Any read error (e.g. the webull_orders_enabled column not existing yet)
    // resolves to FALSE, so the Gateway reports "not configured" and never routes
    // an order here. This is the primary inert switch.
    async isConfigured() {
      try {
        const cfg = cfgOrNull();
        // Config-level markers: order tools wired AND orderCapable explicitly on.
        if (!cfg || cfg.orderCapable !== true || !cfg.orderTools) return false;
        const svc = createServiceClient();
        // A live token must exist (read-only today — a real place still needs the
        // owner to reconnect with order:write scopes).
        if (!(await hasToken(svc, cfg))) return false;
        // Runtime kill switch (column absent today → error → false).
        if (!(await ordersEnabled(svc))) return false;
        // Per-account allowlist (no webull trading row today → false).
        const acct = await resolveTradingAccount(svc);
        return acct.ok;
      } catch {
        return false; // fail closed on any unexpected error
      }
    },

    async submitOrder(o): Promise<BrokerOrderResult> {
      // Defense in depth — the Gateway validates all of this too, but a caller
      // could reach the adapter directly via structural typing.
      if (o.env !== "live") return { ok: false, error: "Webull is live-only (no paper env)" };
      if (!Number.isInteger(o.qty) || o.qty <= 0) {
        return { ok: false, error: `Webull: invalid qty ${o.qty} (must be a positive integer)` };
      }
      if (o.type === "limit" && !(Number.isFinite(o.limitPrice) && (o.limitPrice as number) > 0)) {
        return { ok: false, error: "Webull: limit order requires a positive limitPrice" };
      }

      const cfg = cfgOrNull();
      if (!cfg || cfg.orderCapable !== true || !cfg.orderTools) {
        return { ok: false, error: "Webull orders are not enabled (orderCapable/orderTools)" };
      }
      const svc = createServiceClient();
      // Redundant last-mile kill switch (mirrors robinhood_mcp_enabled on RH).
      if (!(await ordersEnabled(svc))) {
        return { ok: false, error: "Webull orders are disabled (strategy_config.webull_orders_enabled)" };
      }
      // Re-resolve + re-validate the allowlisted trading account at the last code
      // before the wire (the Gateway checks it too — this is the redundant line).
      const acct = await resolveTradingAccount(svc);
      if (!acct.ok) return { ok: false, error: acct.error };

      const tk = await getValidAccessToken(svc, cfg);
      if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "Webull not connected" };
      const token = tk.token;

      const sess = await openSession(cfg, token);
      if (!sess.ok) return { ok: false, error: sess.error ?? "Webull MCP session failed" };
      const sid = sess.sessionId;

      // Discover the order tool schemas so args map onto the exact wire field
      // names / json types (mirrors the Robinhood deterministic path).
      const toolList = await listTools(cfg, token, sid);
      if (!toolList.ok) return { ok: false, error: toolList.error };
      const tools = toolList.tools ?? [];
      const previewTool = tools.find(t => t.name === cfg.orderTools!.preview);
      const placeTool = tools.find(t => t.name === cfg.orderTools!.place);
      if (!placeTool) return { ok: false, error: `${cfg.orderTools.place} not offered by the Webull MCP server` };

      const canonical: Canonical = {
        account: acct.account,
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        type: o.type === "limit" ? "limit" : "market",
        limitPrice: o.limitPrice,
        timeInForce: "DAY",
      };

      // Preview (dry-run) first when offered, and verify the broker's echo matches
      // the intended order. A preview whose side/symbol/qty differs means our
      // schema mapping is wrong (e.g. a dollar-notional field) — abort, never place.
      if (previewTool) {
        const rArgs = buildArgs(previewTool.inputSchema, canonical);
        if ("__error" in rArgs) return { ok: false, error: `preview: ${rArgs.__error}` };
        const preview = await mcpRpc(cfg, token, "tools/call", { name: cfg.orderTools.preview, arguments: rArgs }, sid);
        if (!preview.ok) return { ok: false, error: `${cfg.orderTools.preview} failed: ${preview.error}` };
        const echo = echoMismatch(preview.result?.content ?? preview.result, canonical);
        if (echo) return { ok: false, error: `Webull preview did not match the intended order (${echo}) — refusing to place` };
      }

      const pArgs = buildArgs(placeTool.inputSchema, canonical);
      if ("__error" in pArgs) return { ok: false, error: `place: ${pArgs.__error}` };
      // Account MUST be pinned to the wire args — a place with no account lets the
      // server pick a default. Fail closed if we intended one but none landed.
      if (canonical.account && !ACCOUNT_KEYS.some(k => k in (pArgs as Record<string, any>))) {
        return { ok: false, error: "place: account could not be pinned to order args (schema has no account field) — refusing to place on an unspecified account" };
      }

      let place;
      try {
        place = await mcpRpc(cfg, token, "tools/call", { name: cfg.orderTools.place, arguments: pArgs }, sid);
      } catch (e) {
        // Timed out AFTER possibly placing — never auto-resubmit; force reconcile.
        return { ok: false, needsReconcile: true, error: `place ambiguous (possible success): ${String(e)} — reconcile via ${cfg.orderTools.status} before any retry` };
      }
      if (!place.ok) {
        // A transmitted-but-ambiguous failure may have placed the order. We can't
        // distinguish a definite server rejection from a post-send error here, so
        // fail SAFE: force reconcile rather than a plain failure (a plain failure
        // is resubmittable → double-order risk).
        return { ok: false, needsReconcile: true, error: `place ambiguous: ${place.error} — reconcile via ${cfg.orderTools.status} before any retry` };
      }
      const content = place.result?.content ?? place.result;
      const brokerOrderId = extractOrderId(content);
      // A "success" with no parseable order id can't be tracked/reconciled — treat
      // as ambiguous, not success, so it isn't blindly retried.
      if (!brokerOrderId) {
        return { ok: false, needsReconcile: true, raw: content, error: `place response had no parseable order id — reconcile via ${cfg.orderTools.status} before any retry` };
      }
      return { ok: true, brokerOrderId, raw: content };
    },

    async getOrder(brokerOrderId, env): Promise<BrokerOrderState> {
      if (env !== "live") return { ok: false, error: "Webull is live-only (no paper env)" };
      const cfg = cfgOrNull();
      if (!cfg || !cfg.orderTools) return { ok: false, error: "Webull orders are not enabled (orderTools)" };
      const svc = createServiceClient();
      const tk = await getValidAccessToken(svc, cfg);
      if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "Webull not connected" };
      const sess = await openSession(cfg, tk.token);
      if (!sess.ok) return { ok: false, error: sess.error ?? "Webull MCP session failed" };
      const r = await mcpRpc(cfg, tk.token, "tools/call", {
        name: cfg.orderTools.status, arguments: buildOrderIdArgs(brokerOrderId),
      }, sess.sessionId);
      if (!r.ok) return { ok: false, error: `${cfg.orderTools.status} failed: ${r.error}` };
      const obj = mcpToolJson(r.result?.content ?? r.result);
      const rawStatus = pickStatus(obj);
      return {
        ok: true,
        status: mapWebullStatus(rawStatus),
        filledQty: pickNum(obj, ["filled_quantity", "filledQuantity", "filled_qty", "cumulative_quantity", "executed_quantity"]),
        avgFillPrice: pickNum(obj, ["avg_fill_price", "average_fill_price", "avgFilledPrice", "avg_price", "average_price", "filled_price"]),
        raw: obj ?? (r.result?.content ?? r.result),
      };
    },

    async cancelOrder(brokerOrderId, env) {
      if (env !== "live") return { ok: false, error: "Webull is live-only (no paper env)" };
      const cfg = cfgOrNull();
      if (!cfg || !cfg.orderTools) return { ok: false, error: "Webull orders are not enabled (orderTools)" };
      const svc = createServiceClient();
      const tk = await getValidAccessToken(svc, cfg);
      if (!tk.ok || !tk.token) return { ok: false, error: tk.error ?? "Webull not connected" };
      const sess = await openSession(cfg, tk.token);
      if (!sess.ok) return { ok: false, error: sess.error ?? "Webull MCP session failed" };
      const r = await mcpRpc(cfg, tk.token, "tools/call", {
        name: cfg.orderTools.cancel, arguments: buildOrderIdArgs(brokerOrderId),
      }, sess.sessionId);
      if (!r.ok) return { ok: false, error: `${cfg.orderTools.cancel} failed: ${r.error}` };
      return { ok: true };
    },
  };
}

// ── gating helpers ───────────────────────────────────────────────────────────

// Runtime kill switch. The column does NOT exist today, so this read errors and
// we fail CLOSED (disabled). When the owner adds a boolean
// strategy_config.webull_orders_enabled and sets it true, this returns true.
async function ordersEnabled(svc: any): Promise<boolean> {
  try {
    const { data, error } = await svc.from("strategy_config").select("webull_orders_enabled").limit(1).maybeSingle();
    if (error) return false; // column missing / read error → disabled
    return (data as any)?.webull_orders_enabled === true;
  } catch {
    return false;
  }
}

// Fail-closed account resolution: the Webull US trading account must be an
// allowlisted broker_accounts row (broker='webull', market='us', role='trading').
// There is NONE today, so this always fails closed and no order can be placed.
async function resolveTradingAccount(svc: any): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const { data, error } = await svc
      .from("broker_accounts")
      .select("account_number, role")
      .eq("broker", "webull")
      .eq("market", "us")
      .eq("role", "trading")
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false, error: `webull allowlist read failed: ${error.message}` };
    const account = (data as any)?.account_number;
    if (!account || (data as any)?.role !== "trading") {
      return { ok: false, error: "No allowlisted Webull trading account (broker_accounts broker='webull' role='trading')" };
    }
    return { ok: true, account: String(account) };
  } catch (e) {
    return { ok: false, error: `webull account resolution error: ${String(e)}` };
  }
}

// ── MCP session helpers (mcp-driver does not export openSession/listTools) ─────
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

// ── deterministic arg building (schema-aware; mirrors robinhood-mcp) ───────────
type Canonical = {
  account: string; symbol: string; side: "buy" | "sell"; qty: number;
  type: "market" | "limit"; limitPrice?: number; timeInForce: string;
};

const ACCOUNT_KEYS = ["account_id", "account_number", "account", "accountId"];

// Deliberately NARROW aliases. Notably `qty` NEVER maps to `amount`/`notional`
// (dollar fields on many broker APIs) — mapping 10 shares → amount:10 could place
// a $10 order. If the schema only offers a dollar field we fail closed below.
const ALIASES: Record<keyof Canonical, string[]> = {
  account: ACCOUNT_KEYS,
  symbol: ["symbol", "ticker", "stock", "instrument", "instrument_id"],
  side: ["side", "action", "transaction_type", "direction"],
  qty: ["quantity", "qty", "shares"],
  type: ["order_type", "orderType", "type"],
  limitPrice: ["limit_price", "limitPrice", "price"],
  timeInForce: ["time_in_force", "timeInForce", "tif"],
};

function buildArgs(schema: any, c: Canonical): Record<string, any> | { __error: string } {
  const props = schema?.properties ?? {};
  const required: string[] = schema?.required ?? [];
  const out: Record<string, any> = {};
  for (const canonKey of Object.keys(ALIASES) as (keyof Canonical)[]) {
    let v: any = c[canonKey];
    if (v === undefined || v === null) continue;
    const hit = ALIASES[canonKey].find(n => n in props);
    if (!hit) continue;
    if (canonKey === "side") {
      const coerced = coerceEnum(props[hit], v === "buy" ? ["BUY", "buy", "Buy", "B"] : ["SELL", "sell", "Sell", "S"]);
      if (coerced === undefined) return { __error: `side enum not resolvable against schema for '${hit}' (enum=${JSON.stringify(props[hit]?.enum)})` };
      v = coerced;
    } else if (canonKey === "type") {
      const coerced = coerceEnum(props[hit], v === "limit" ? ["LIMIT", "limit", "Limit"] : ["MARKET", "market", "Market"]);
      if (coerced === undefined) return { __error: `order_type enum not resolvable against schema for '${hit}'` };
      v = coerced;
    } else if (canonKey === "timeInForce") {
      const coerced = coerceEnum(props[hit], ["DAY", "day", "GFD", "gfd", "GTC", "gtc"]);
      if (coerced === undefined) continue; // optional — skip rather than send a value the server may reject
      v = coerced;
    }
    // Coerce to the schema's DECLARED json type (type may be a string or an
    // array like ["string","null"]). Some brokers want numeric fields as strings.
    const rawType = props[hit]?.type;
    const declType: string | undefined = Array.isArray(rawType) ? rawType.find((t: string) => t !== "null") : rawType;
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

// Build args for the status/cancel tools, which take only an order id. We can't
// know the exact key name without the schema, so send the common candidates; the
// server ignores the ones it doesn't recognise.
function buildOrderIdArgs(orderId: string): Record<string, any> {
  return { order_id: orderId, orderId, id: orderId };
}

function coerceEnum(prop: any, candidates: string[]): string | undefined {
  const en: string[] | undefined = prop?.enum;
  if (Array.isArray(en) && en.length) return candidates.find(c => en.includes(c));
  return candidates[0];
}

// ── response parsing ───────────────────────────────────────────────────────────
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
function pickNum(obj: any, paths: string[]): number | undefined {
  const v = pick(obj, paths);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function pickStatus(obj: any): string {
  const data = obj?.data ?? obj;
  const v = pick(data, ["status", "order_status", "orderStatus", "state"]) ?? pick(obj, ["status", "order_status", "orderStatus", "state"]);
  return v == null ? "" : String(v);
}

// Webull order status → our BrokerOrderState.status enum. Case-insensitive and
// tolerant of Webull's several spellings (documented statuses include Pending /
// Working / Filled / Partially Filled / Cancelled / Rejected / Failed / Expired).
// Anything unrecognised maps to "submitted" (in-flight) so we never misreport an
// unknown state as a terminal fill/cancel.
function mapWebullStatus(raw: string): BrokerOrderState["status"] {
  const s = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (!s) return "submitted";
  if (s.includes("partial")) return "partially_filled";      // "PartiallyFilled"
  if (s.includes("fill") || s === "filled" || s === "executed") return "filled";
  if (s.includes("cancel")) return "canceled";               // "Cancelled" / "Canceled"
  if (s.includes("reject") || s.includes("fail") || s.includes("denied")) return "rejected";
  if (s.includes("expire")) return "expired";
  // pending / working / submitted / queued / new / accepted / open / partial... → in-flight
  return "submitted";
}

// MCP tool results come back as [{type:"text", text:"<JSON string>"}]. Prefer the
// structured id; fall back to a narrow regex. Never grab a bare "id" unless it is
// the only UUID-shaped value, to avoid copying an instrument/account/request id.
function extractOrderId(content: any): string | undefined {
  try {
    const obj = mcpToolJson(content);
    const nested = obj?.data?.order?.id ?? obj?.order?.id ?? obj?.data?.order_id ?? obj?.data?.orderId ?? obj?.order_id ?? obj?.orderId ?? obj?.data?.id ?? obj?.id;
    if ((typeof nested === "string" && nested.length >= 6) || (typeof nested === "number" && Number.isFinite(nested))) {
      return String(nested);
    }
    const un = mcpToolText(content).replace(/\\"/g, '"');
    const orderM = un.match(/"order[_-]?id"\s*:\s*"?([0-9A-Za-z-]{6,})"?/i);
    if (orderM) return orderM[1];
    const uuidRe = /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/ig;
    const uuids = [...un.matchAll(uuidRe)];
    if (uuids.length === 1) return uuids[0][1];
    return undefined;
  } catch {
    return undefined;
  }
}

function mcpToolText(content: any): string {
  if (Array.isArray(content)) return content.map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c))).join("\n");
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

// Returns a human-readable mismatch string if the preview does not match the
// intended order; null if consistent. A field ABSENT from an opaque preview is not
// hard-failed, but a PRESENT-and-WRONG value aborts the place.
function echoMismatch(content: any, c: Canonical): string | null {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parsed = mcpToolJson(content);
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

  const sideField = flat["side"] ?? flat["action"] ?? flat["transaction_type"] ?? flat["direction"];
  if (sideField != null && !String(sideField).toLowerCase().includes(c.side)) return `side ${c.side} != preview ${sideField}`;
  const acctField = flat["account_id"] ?? flat["account_number"] ?? flat["account"];
  if (acctField != null && c.account && !String(acctField).includes(c.account)) return `account ${c.account} != preview ${acctField}`;
  const typeField = flat["order_type"] ?? flat["ordertype"] ?? flat["type"];
  if (typeField != null && c.type && !String(typeField).toLowerCase().includes(c.type)) return `type ${c.type} != preview ${typeField}`;

  const s = (typeof content === "string" ? content : JSON.stringify(content ?? "")).toUpperCase();
  if (!s) return null;
  if (s.includes("SYMBOL") && !new RegExp(`\\b${esc(c.symbol.toUpperCase())}\\b`).test(s)) return `symbol ${c.symbol} not in preview`;
  if (sideField == null) {
    const wantSide = c.side.toUpperCase();
    const otherSide = c.side === "buy" ? "SELL" : "BUY";
    if (new RegExp(`\\b${otherSide}\\b`).test(s) && !new RegExp(`\\b${wantSide}\\b`).test(s)) return `side ${c.side} not in preview (found ${otherSide})`;
  }
  const qtyM = s.match(/"?(?:QUANTITY|QTY|SHARES)"?\s*[:=]\s*"?(\d+(?:\.\d+)?)"?/);
  if (qtyM && Math.trunc(Number(qtyM[1])) !== Math.trunc(c.qty)) return `qty ${c.qty} != preview ${qtyM[1]}`;
  return null;
}
