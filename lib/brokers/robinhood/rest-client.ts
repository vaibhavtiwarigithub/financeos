import type { SupabaseClient } from "@supabase/supabase-js";

// Direct Robinhood REST client. Used by the `robinhood` execution adapter so the
// order path works in Vercel serverless (the MCP adapter needs a live MCP
// session, which serverless cron/route handlers do not have). Deterministic, no
// LLM. The OAuth token is read from the vault; the account is passed in by the
// adapter after the gateway has validated it against the allowlist.
const RH_API = "https://api.robinhood.com";
// ONLY account permitted for order placement — never order from read-only 965848641.
export const RH_ORDER_ACCOUNT_ID = "605420660";

async function getRhToken(svc: SupabaseClient): Promise<string> {
  const { data } = await svc
    .from("api_key_vault")
    .select("key_value")
    .eq("key_name", "ROBINHOOD_MCP_ACCESS_TOKEN")
    .maybeSingle();
  const raw = (data as any)?.key_value;
  if (!raw) throw new Error("Robinhood OAuth token not found in vault (key: ROBINHOOD_MCP_ACCESS_TOKEN)");
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.access_token) return String(parsed.access_token);
  } catch {
    // raw string token — use directly
  }
  return String(raw);
}

export async function hasRhRestToken(svc: SupabaseClient): Promise<boolean> {
  try { await getRhToken(svc); return true; } catch { return false; }
}

async function rhInstrumentUrl(token: string, symbol: string): Promise<string> {
  const res = await fetch(
    `${RH_API}/instruments/?symbol=${encodeURIComponent(symbol)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`RH instruments lookup ${res.status} for ${symbol}: ${await res.text()}`);
  }
  const body = await res.json();
  const url: string | undefined = body?.results?.[0]?.url;
  if (!url) throw new Error(`No Robinhood instrument found for symbol: ${symbol}`);
  return url;
}

export interface RhOrderResult {
  ok: boolean;
  order_id?: string;
  needs_reconcile?: boolean;
  error?: string;
  raw?: any;
}

// Place a market order. `side` and `account` are explicit — the account is the
// allowlist-validated one the gateway resolved (defaults to the single permitted
// order account for safety).
export async function rhPlaceMarketOrder(
  svc: SupabaseClient,
  opts: { symbol: string; qty: number; side: "buy" | "sell"; account?: string },
): Promise<RhOrderResult> {
  if (opts.qty < 1 || !Number.isInteger(opts.qty)) {
    return { ok: false, error: `Invalid qty: ${opts.qty}` };
  }
  const accountId = opts.account || RH_ORDER_ACCOUNT_ID;

  let token: string;
  let instrumentUrl: string;
  try {
    token = await getRhToken(svc);
    instrumentUrl = await rhInstrumentUrl(token, opts.symbol);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  const body = new URLSearchParams({
    account: `${RH_API}/accounts/${accountId}/`,
    instrument: instrumentUrl,
    symbol: opts.symbol,
    side: opts.side,
    type: "market",
    time_in_force: "gfd",
    trigger: "immediate",
    quantity: String(opts.qty),
  });

  let res: Response;
  try {
    res = await fetch(`${RH_API}/orders/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (e: any) {
    // Network failure AFTER the request may have reached the broker — ambiguous.
    return { ok: false, needs_reconcile: true, error: `RH order network error (ambiguous): ${e?.message ?? String(e)}` };
  }

  let payload: any = null;
  try { payload = await res.json(); } catch { /* non-JSON response */ }

  if (!res.ok) {
    return { ok: false, error: `RH order submit ${res.status}: ${JSON.stringify(payload ?? "")}`, raw: payload };
  }

  const orderId: string | undefined = payload?.id;
  if (!orderId) {
    return { ok: true, needs_reconcile: true, error: "No order id in RH response", raw: payload };
  }
  return { ok: true, order_id: String(orderId), raw: payload };
}

export interface RhOrderStatus {
  ok: boolean;
  status?: "submitted" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired";
  filledQty?: number;
  avgFillPrice?: number;
  raw?: any;
  error?: string;
}

// Map Robinhood order state → the gateway's status union.
function mapRhState(state: string): RhOrderStatus["status"] {
  switch (state) {
    case "filled": return "filled";
    case "partially_filled": return "partially_filled";
    case "cancelled":
    case "canceled": return "canceled";
    case "rejected":
    case "failed": return "rejected";
    case "expired": return "expired";
    default: return "submitted"; // queued / confirmed / unconfirmed
  }
}

export async function rhGetOrder(svc: SupabaseClient, orderId: string): Promise<RhOrderStatus> {
  let token: string;
  try { token = await getRhToken(svc); } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  let res: Response;
  try {
    res = await fetch(`${RH_API}/orders/${encodeURIComponent(orderId)}/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (e: any) { return { ok: false, error: `RH order status network error: ${e?.message ?? String(e)}` }; }
  let payload: any = null;
  try { payload = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) return { ok: false, error: `RH order status ${res.status}: ${JSON.stringify(payload ?? "")}` };
  return {
    ok: true,
    status: mapRhState(String(payload?.state ?? "")),
    filledQty: payload?.cumulative_quantity != null ? Number(payload.cumulative_quantity) : undefined,
    avgFillPrice: payload?.average_price != null ? Number(payload.average_price) : undefined,
    raw: payload,
  };
}

export async function rhCancelOrder(svc: SupabaseClient, orderId: string): Promise<{ ok: boolean; error?: string }> {
  let token: string;
  try { token = await getRhToken(svc); } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  try {
    const res = await fetch(`${RH_API}/orders/${encodeURIComponent(orderId)}/cancel/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `RH cancel ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (e: any) { return { ok: false, error: `RH cancel network error: ${e?.message ?? String(e)}` }; }
}
