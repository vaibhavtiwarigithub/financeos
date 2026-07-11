import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { reportIssue, resolveIssue } from "@/lib/system-health";

// Zerodha Kite Connect — auth + session helpers.
//
// Kite's access token expires at the end of each trading day, so this is a
// daily one-click login: /api/kite/login redirects to Kite → user authorizes →
// Kite redirects to /api/kite/callback with a request_token → we exchange it
// (api_key + request_token + SHA256(api_key+request_token+api_secret)) for an
// access_token, which we store (in api_key_vault, reusing the existing table —
// no extra migration) and reuse for the rest of the day.

const VAULT_ACCESS_TOKEN = "KITE_ACCESS_TOKEN";

async function readVault(svc: any, keyName: string): Promise<{ value: string; updatedAt: string | null }> {
  try {
    const { data } = await svc.from("api_key_vault").select("key_value, updated_at").eq("key_name", keyName).maybeSingle();
    return { value: (data as any)?.key_value ?? "", updatedAt: (data as any)?.updated_at ?? null };
  } catch {
    return { value: "", updatedAt: null };
  }
}

export async function getKiteCreds(svc?: any): Promise<{ apiKey: string; apiSecret: string }> {
  const s = svc ?? createServiceClient();
  const [apiKey, apiSecret] = await Promise.all([readVault(s, "KITE_API_KEY"), readVault(s, "KITE_API_SECRET")]);
  return {
    apiKey: apiKey.value || process.env.KITE_API_KEY || "",
    apiSecret: apiSecret.value || process.env.KITE_API_SECRET || "",
  };
}

export function kiteLoginUrl(apiKey: string): string {
  return `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
}

// Exchange the request_token from the redirect for a full access_token.
export async function exchangeRequestToken(
  apiKey: string, apiSecret: string, requestToken: string
): Promise<{ ok: true; accessToken: string; userId?: string } | { ok: false; error: string }> {
  const checksum = crypto.createHash("sha256").update(apiKey + requestToken + apiSecret).digest("hex");
  try {
    const res = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Kite-Version": "3" },
      body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
    });
    const json = await res.json();
    if (!res.ok || json?.status !== "success") {
      return { ok: false, error: json?.message ?? `Kite session exchange failed (${res.status})` };
    }
    return { ok: true, accessToken: json.data.access_token, userId: json.data.user_id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function storeAccessToken(svc: any, accessToken: string): Promise<void> {
  await svc.from("api_key_vault").upsert(
    {
      key_name: VAULT_ACCESS_TOKEN,
      key_value: accessToken,
      provider: "other",
      display_name: "Kite daily access token",
      notes: "Auto-refreshed on each daily Kite login. Expires end of trading day.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key_name" }
  );
}

// The stored token is only usable the day it was generated (Kite expires it
// end-of-day). Treat a token whose updated_at isn't today as expired.
export async function getAccessToken(svc?: any): Promise<{ token: string; fresh: boolean; updatedAt: string | null }> {
  const s = svc ?? createServiceClient();
  const { value, updatedAt } = await readVault(s, VAULT_ACCESS_TOKEN);
  const today = new Date().toISOString().slice(0, 10);
  const fresh = !!value && !!updatedAt && String(updatedAt).slice(0, 10) === today;
  return { token: value, fresh, updatedAt };
}

// Kill switch: invalidate the session with Kite itself (DELETE /session/token
// — Kite's documented endpoint takes api_key/access_token as query params, not
// the usual Authorization header, so this doesn't reuse kiteDelete) AND wipe
// the stored token locally regardless of whether the remote call succeeds —
// an unreachable Kite API must never leave a stale token sitting in the vault
// looking "connected". The most reliable kill switch is still revoking from
// Zerodha's own console (works even if this app/DB is fully compromised);
// this is the in-app-triggered complement to that, not a replacement for it.
export async function disconnectKite(svc?: any): Promise<{ ok: boolean; remoteInvalidated: boolean; error?: string }> {
  const s = svc ?? createServiceClient();
  const { apiKey } = await getKiteCreds(s);
  const { token } = await getAccessToken(s);

  let remoteInvalidated = false;
  let remoteError: string | undefined;
  if (apiKey && token) {
    try {
      const res = await fetch(`https://api.kite.trade/session/token?api_key=${encodeURIComponent(apiKey)}&access_token=${encodeURIComponent(token)}`, {
        method: "DELETE",
        headers: { "X-Kite-Version": "3" },
      });
      const json = await res.json().catch(() => ({}));
      remoteInvalidated = res.ok && json?.status === "success";
      if (!remoteInvalidated) remoteError = json?.message ?? `Kite ${res.status}`;
    } catch (e) {
      remoteError = String(e);
    }
  }

  // Wipe locally no matter what the remote call did — a network error talking
  // to Kite must not block disconnecting on this side.
  const { error: deleteErr } = await s.from("api_key_vault").delete().eq("key_name", VAULT_ACCESS_TOKEN);

  return {
    ok: !deleteErr,
    remoteInvalidated,
    error: deleteErr ? deleteErr.message : remoteError,
  };
}

async function authHeaders(s: any): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
  const { apiKey } = await getKiteCreds(s);
  const { token, fresh } = await getAccessToken(s);
  // No creds/token = simply not connected (not a fault) — don't alert.
  if (!apiKey || !token) return { ok: false, error: "Kite not connected — log in via /api/kite/login" };
  if (!fresh) {
    // A connected Kite session whose daily token expired IS a fault — India
    // holdings + live orders stop working until the user re-logs in.
    await reportIssue({
      issueKey: "broker-token:kite",
      severity: "warn", category: "broker",
      title: "Kite session expired (daily) — re-login required",
      detail: "Zerodha access tokens expire every morning. India holdings and live orders will fail until you re-login via Settings → Kite.",
    }, s);
    return { ok: false, error: "Kite token expired (daily) — re-login via /api/kite/login" };
  }
  await resolveIssue("broker-token:kite", s);
  return { ok: true, headers: { "X-Kite-Version": "3", Authorization: `token ${apiKey}:${token}` } };
}

// Authenticated GET against the Kite REST API using the stored daily token.
export async function kiteGet(path: string, svc?: any): Promise<{ ok: boolean; data?: any; error?: string }> {
  const s = svc ?? createServiceClient();
  const h = await authHeaders(s);
  if (!h.ok) return { ok: false, error: h.error };
  try {
    const res = await fetch(`https://api.kite.trade${path}`, { headers: h.headers });
    const json = await res.json();
    if (!res.ok || json?.status !== "success") return { ok: false, error: json?.message ?? `Kite ${res.status}` };
    return { ok: true, data: json.data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Authenticated form-encoded POST (order placement etc).
export async function kitePost(path: string, body: Record<string, string>, svc?: any): Promise<{ ok: boolean; data?: any; error?: string }> {
  const s = svc ?? createServiceClient();
  const h = await authHeaders(s);
  if (!h.ok) return { ok: false, error: h.error };
  try {
    const res = await fetch(`https://api.kite.trade${path}`, {
      method: "POST",
      headers: { ...h.headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    const json = await res.json();
    if (!res.ok || json?.status !== "success") return { ok: false, error: json?.message ?? `Kite ${res.status}` };
    return { ok: true, data: json.data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Authenticated DELETE (order cancellation).
export async function kiteDelete(path: string, svc?: any): Promise<{ ok: boolean; data?: any; error?: string }> {
  const s = svc ?? createServiceClient();
  const h = await authHeaders(s);
  if (!h.ok) return { ok: false, error: h.error };
  try {
    const res = await fetch(`https://api.kite.trade${path}`, { method: "DELETE", headers: h.headers });
    const json = await res.json();
    if (!res.ok || json?.status !== "success") return { ok: false, error: json?.message ?? `Kite ${res.status}` };
    return { ok: true, data: json.data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function getKiteHoldings(svc?: any) {
  return kiteGet("/portfolio/holdings", svc);
}

// Place a Kite GTT (Good Till Triggered) two-leg bracket: one stop-loss leg (SL-M)
// and one take-profit leg (LIMIT). Both legs are SELL CNC. Kite cancels the other
// leg automatically when either fires. Used for server-side stop/target on live BUYs.
export async function placeKiteGtt(opts: {
  tradingsymbol: string;
  exchange?: string;
  qty: number;
  lastPrice: number;   // reference price at order time (pre-order quote)
  stopPrice: number;   // trigger price for the stop-loss leg
  targetPrice: number; // trigger + limit price for the take-profit leg
}, svc?: any): Promise<{ ok: boolean; triggerId?: number; error?: string }> {
  const sym = opts.tradingsymbol.replace(/\.(NS|BO)$/i, "");
  const exchange = opts.exchange ?? (opts.tradingsymbol.toUpperCase().endsWith(".BO") ? "BSE" : "NSE");
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // Kite GTT accepts trigger_values and orders as JSON strings in the form body.
  const body: Record<string, string> = {
    type: "two-leg",
    tradingsymbol: sym,
    exchange,
    trigger_values: JSON.stringify([round2(opts.stopPrice), round2(opts.targetPrice)]),
    last_price: String(round2(opts.lastPrice)),
    orders: JSON.stringify([
      { transaction_type: "SELL", quantity: opts.qty, order_type: "SL-M", product: "CNC", price: 0 },
      { transaction_type: "SELL", quantity: opts.qty, order_type: "LIMIT", product: "CNC", price: round2(opts.targetPrice) },
    ]),
  };
  const r = await kitePost("/gtt/triggers", body, svc);
  if (!r.ok) return { ok: false, error: r.error };
  const triggerId = Number(r.data?.trigger_id);
  if (!Number.isFinite(triggerId)) return { ok: false, error: "GTT placed but no trigger_id returned" };
  return { ok: true, triggerId };
}

// Cancel a Kite GTT trigger by ID (e.g. when a position is manually sold before
// stop/target fires). Best-effort: caller should not hard-fail on cancellation errors
// since Kite would reject the trigger anyway once the position is zero.
export async function cancelKiteGtt(triggerId: number, svc?: any): Promise<{ ok: boolean; error?: string }> {
  const r = await kiteDelete(`/gtt/triggers/${triggerId}`, svc);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** Liquid cash balance from Kite /user/margins (equity.net). Combine with
 *  getKiteHoldings() to compute total India account NAV = equityNet + Σ(last_price × qty). */
export async function getKiteMargins(svc?: any): Promise<{ ok: boolean; equityNet?: number; error?: string }> {
  const r = await kiteGet("/user/margins", svc);
  if (!r.ok) return { ok: false, error: r.error };
  const net = Number(r.data?.equity?.net);
  if (!Number.isFinite(net)) return { ok: false, error: "Kite /user/margins did not return equity.net" };
  return { ok: true, equityNet: net };
}

// Verify that the connected Kite session actually belongs to the configured
// India trading account — the wrong-account guard for every live Kite submit.
//
// The two-step text allowlist (config → broker_accounts role='trading') only
// proves the *configured value* is a permitted target. It does NOT prove the
// *live token* belongs to that account: Kite routes every order through the one
// connected Zerodha session regardless of what account string is configured, so
// a token minted for a DIFFERENT Zerodha identity would still place the order.
// Bind the two: Kite's /user/profile returns the immutable `user_id`, which must
// equal the selected account. FAIL CLOSED on any read error, missing config,
// non-allowlisted / view_only account, unverifiable session, or identity
// mismatch — never a silent fallback. Status codes mirror the standalone route's
// contract (403 refuse, 500 config/allowlist read error, 502 identity unverifiable).
export async function verifyKiteTradingIdentity(
  svc?: any
): Promise<{ ok: true; account: string } | { ok: false; status: 403 | 500 | 502; error: string }> {
  const s = svc ?? createServiceClient();

  const { data: acctCfg, error: acctCfgErr } = await s
    .from("strategy_config").select("active_account_india").limit(1).maybeSingle();
  if (acctCfgErr) {
    return { ok: false, status: 500, error: `Account config read failed — refusing live India order (fail-closed): ${acctCfgErr.message}` };
  }
  const indiaAccount = (acctCfg as any)?.active_account_india;
  if (!indiaAccount) {
    return { ok: false, status: 403, error: "No active India trading account set — refusing live India order. Set it in Settings → Agents." };
  }

  const { data: allowed, error: allowErr } = await s
    .from("broker_accounts").select("role")
    .eq("broker", "kite").eq("account_number", indiaAccount).eq("market", "india").maybeSingle();
  if (allowErr) {
    return { ok: false, status: 500, error: `Allowlist read failed — refusing live India order (fail-closed): ${allowErr.message}` };
  }
  if (!allowed) {
    return { ok: false, status: 403, error: `Account ${indiaAccount} is not an allowlisted Kite account for India — refusing live order.` };
  }
  if ((allowed as any).role !== "trading") {
    return { ok: false, status: 403, error: `Account ${indiaAccount} is view_only — not a permitted order target.` };
  }

  // The connected session must actually BE that account.
  const profile = await kiteGet("/user/profile", s);
  if (!profile.ok) {
    return { ok: false, status: 502, error: `Could not verify the connected Kite identity (${profile.error ?? "profile fetch failed"}) — refusing live India order (fail-closed).` };
  }
  const sessionUserId = String((profile.data as any)?.user_id ?? "").trim();
  if (!sessionUserId) {
    return { ok: false, status: 502, error: "Kite /user/profile returned no user_id — cannot bind the session to the trading account (fail-closed)." };
  }
  if (sessionUserId !== String(indiaAccount).trim()) {
    return { ok: false, status: 403, error: `Connected Kite session (user_id ${sessionUserId}) does not match the configured India trading account ${indiaAccount} — refusing live order (wrong-account guard).` };
  }
  return { ok: true, account: String(indiaAccount) };
}

// Place a real equity order (POST /orders/regular). CNC = delivery (cash &
// carry), the right product for holding equity. Only called from a
// user-initiated, explicitly-confirmed request — never auto-fired.
//
// UNIVERSAL identity backstop: every programmatic Kite submit funnels through
// here (the standalone route AND kiteAdapter.submitOrder → canonical /
// autonomous / protective-exit paths). So the verified-identity gate lives here
// too — even paths that never touch the standalone route's block cannot reach
// the broker with a mismatched session. Fail-closed before the wire call.
export async function placeEquityOrder(opts: {
  tradingsymbol: string; exchange?: string; transaction_type: "BUY" | "SELL";
  quantity: number; order_type?: "MARKET" | "LIMIT"; price?: number;
  product?: "CNC" | "MIS" | "NRML"; validity?: "DAY" | "IOC";
}, svc?: any): Promise<{ ok: boolean; data?: any; error?: string }> {
  const s = svc ?? createServiceClient();

  const identity = await verifyKiteTradingIdentity(s);
  if (!identity.ok) return { ok: false, error: identity.error };

  const body: Record<string, string> = {
    tradingsymbol: opts.tradingsymbol.replace(/\.(NS|BO)$/i, ""), // Kite wants the bare symbol
    exchange: opts.exchange ?? (opts.tradingsymbol.toUpperCase().endsWith(".BO") ? "BSE" : "NSE"),
    transaction_type: opts.transaction_type,
    order_type: opts.order_type ?? "MARKET",
    quantity: String(Math.max(1, Math.floor(opts.quantity))),
    product: opts.product ?? "CNC",
    validity: opts.validity ?? "DAY",
  };
  if ((opts.order_type ?? "MARKET") === "LIMIT" && opts.price != null) body.price = String(opts.price);
  return kitePost("/orders/regular", body, s);
}
