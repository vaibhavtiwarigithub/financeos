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

// ── Portfolio data (read-only, for risk analytics) ───────────────────────────

export interface RhAccountInfo {
  id: string;          // account_number e.g. "605420660"
  totalEquity: number; // portfolio equity value in USD
  cashBalance: number; // uninvested cash
  buyingPower: number;
}

export interface RhFullPosition {
  symbol: string;
  qty: number;
  avgCost: number;
  currentPrice: number;
  accountId: string;   // account_number this position belongs to
}

// Follow Robinhood pagination — returns all pages merged.
async function rhPaginateAll(token: string, startUrl: string): Promise<any[]> {
  const results: any[] = [];
  let url: string | null = startUrl;
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`RH fetch ${res.status}: ${url}`);
    const body = await res.json();
    results.push(...(body.results ?? []));
    url = body.next ?? null;
  }
  return results;
}

// Batch resolve instrument URLs → symbol. Extracts the UUID from each URL and
// calls /instruments/?ids=... in batches of 50.
async function rhResolveInstruments(token: string, instrumentUrls: string[]): Promise<Map<string, string>> {
  const urlToId = new Map<string, string>();
  for (const u of instrumentUrls) {
    const id = u.replace(/\/$/, "").split("/").pop();
    if (id) urlToId.set(u, id);
  }
  const uniqueIds = [...new Set(urlToId.values())];
  const idToSymbol = new Map<string, string>();
  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50);
    try {
      const res = await fetch(`${RH_API}/instruments/?ids=${batch.join(",")}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) continue;
      const body = await res.json();
      for (const inst of (body.results ?? [])) {
        if (inst.id && inst.symbol) idToSymbol.set(inst.id, inst.symbol);
      }
    } catch { /* best effort */ }
  }
  // Build final map: instrument URL → symbol
  const out = new Map<string, string>();
  for (const [url, id] of urlToId) {
    const sym = idToSymbol.get(id);
    if (sym) out.set(url, sym);
  }
  return out;
}

// Batch fetch last trade prices for US symbols via /quotes/?symbols=...
async function rhGetLastPrices(token: string, symbols: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const unique = [...new Set(symbols)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    try {
      const res = await fetch(`${RH_API}/quotes/?symbols=${batch.join(",")}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) continue;
      const body = await res.json();
      for (const q of (body.results ?? [])) {
        if (!q?.symbol) continue;
        const price = parseFloat(q.last_trade_price ?? q.last_extended_hours_trade_price ?? "0");
        if (price > 0) map.set(q.symbol, price);
      }
    } catch { /* best effort */ }
  }
  return map;
}

export async function rhFetchAccounts(svc: SupabaseClient): Promise<{ accounts: RhAccountInfo[]; error?: string }> {
  try {
    const token = await getRhToken(svc);
    const res = await fetch(`${RH_API}/accounts/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`RH accounts ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return {
      accounts: (body.results ?? []).map((a: any) => ({
        id: String(a.account_number ?? ""),
        totalEquity: parseFloat(a.equity ?? a.extended_hours_equity ?? "0"),
        cashBalance: parseFloat(a.portfolio_cash ?? "0"),
        buyingPower: parseFloat(a.buying_power ?? "0"),
      })).filter((a: RhAccountInfo) => a.id),
    };
  } catch (e: any) {
    return { accounts: [], error: e?.message ?? String(e) };
  }
}

export async function rhFetchAllPositions(svc: SupabaseClient): Promise<{ positions: RhFullPosition[]; error?: string }> {
  try {
    const token = await getRhToken(svc);
    const raw = await rhPaginateAll(token, `${RH_API}/positions/?nonzero=true`);
    if (!raw.length) return { positions: [] };

    // Resolve instrument URLs → symbols
    const instrumentUrls = [...new Set(raw.map((p: any) => p.instrument).filter(Boolean))];
    const symMap = await rhResolveInstruments(token, instrumentUrls);

    // Build positions with symbols + account IDs
    const withSymbols = raw
      .map((p: any) => ({
        symbol: symMap.get(p.instrument) ?? "",
        accountId: (p.account ?? "").replace(/\/$/, "").split("/").pop() ?? "",
        qty: parseFloat(p.quantity ?? "0"),
        avgCost: parseFloat(p.average_buy_price ?? "0"),
        instrumentUrl: p.instrument,
      }))
      .filter((p: any) => p.symbol && p.qty > 0);

    if (!withSymbols.length) return { positions: [] };

    // Fetch live prices in bulk
    const symbols = [...new Set(withSymbols.map((p: any) => p.symbol))];
    const priceMap = await rhGetLastPrices(token, symbols);

    return {
      positions: withSymbols.map((p: any) => ({
        symbol: p.symbol,
        qty: p.qty,
        avgCost: p.avgCost,
        currentPrice: priceMap.get(p.symbol) ?? p.avgCost,
        accountId: p.accountId,
      })),
    };
  } catch (e: any) {
    return { positions: [], error: e?.message ?? String(e) };
  }
}
