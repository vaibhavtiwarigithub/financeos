import type { SupabaseClient } from "@supabase/supabase-js";

const RH_API = "https://api.robinhood.com";
// ONLY account permitted for order placement — never order from read-only 965848641.
const ORDER_ACCOUNT_ID = "605420660";

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
}

export async function rhPlaceMarketOrder(
  svc: SupabaseClient,
  opts: { symbol: string; qty: number },
): Promise<RhOrderResult> {
  if (opts.qty < 1 || !Number.isInteger(opts.qty)) {
    return { ok: false, error: `Invalid qty: ${opts.qty}` };
  }

  const token = await getRhToken(svc);
  const instrumentUrl = await rhInstrumentUrl(token, opts.symbol);

  const body = new URLSearchParams({
    account: `${RH_API}/accounts/${ORDER_ACCOUNT_ID}/`,
    instrument: instrumentUrl,
    symbol: opts.symbol,
    side: "buy",
    type: "market",
    time_in_force: "gfd",
    trigger: "immediate",
    quantity: String(opts.qty),
  });

  const res = await fetch(`${RH_API}/orders/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  let payload: any = null;
  try { payload = await res.json(); } catch { /* non-JSON response */ }

  if (!res.ok) {
    return {
      ok: false,
      error: `RH order submit ${res.status}: ${JSON.stringify(payload ?? await res.text())}`,
    };
  }

  const orderId: string | undefined = payload?.id;
  if (!orderId) {
    return { ok: true, needs_reconcile: true, error: "No order id in RH response" };
  }

  return { ok: true, order_id: String(orderId) };
}
