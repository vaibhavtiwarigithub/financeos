// Execution Gateway (spec Part A) — Alpaca order submission/status/cancel.
// Reuses the vault-key pattern from lib/brokers/alpaca.ts. All fetches fail
// soft (never throw) so a broker hiccup shows as a clean error, not a crash.

import { createServiceClient } from "@/lib/supabase/service";

async function getAlpacaKeys(paper: boolean): Promise<{ key: string; secret: string } | null> {
  const sb = createServiceClient();
  const keyName = paper ? "ALPACA_PAPER_API_KEY" : "ALPACA_API_KEY";
  const secretName = paper ? "ALPACA_PAPER_API_SECRET" : "ALPACA_API_SECRET";
  const [{ data: k }, { data: s }] = await Promise.all([
    sb.from("api_key_vault").select("key_value").eq("key_name", keyName).maybeSingle(),
    sb.from("api_key_vault").select("key_value").eq("key_name", secretName).maybeSingle(),
  ]);
  const key = (k as any)?.key_value ?? (paper ? process.env.ALPACA_PAPER_API_KEY : process.env.ALPACA_API_KEY);
  const secret = (s as any)?.key_value ?? (paper ? process.env.ALPACA_PAPER_API_SECRET : process.env.ALPACA_API_SECRET);
  if (!key || !secret) return null;
  return { key, secret };
}

function baseUrl(env: "paper" | "live"): string {
  return env === "paper" ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
}

async function alpacaFetch(path: string, env: "paper" | "live", init?: RequestInit): Promise<{ ok: boolean; data?: any; error?: string }> {
  const creds = await getAlpacaKeys(env === "paper");
  if (!creds) return { ok: false, error: "No Alpaca API keys configured for this environment" };
  try {
    const res = await fetch(`${baseUrl(env)}${path}`, {
      ...init,
      headers: { "APCA-API-KEY-ID": creds.key, "APCA-API-SECRET-KEY": creds.secret, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) return { ok: false, error: data?.message ?? `Alpaca ${res.status}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function submitAlpacaOrder(o: {
  symbol: string; side: "buy" | "sell"; qty: number; type?: "market" | "limit"; limitPrice?: number; env: "paper" | "live";
}): Promise<{ ok: boolean; brokerOrderId?: string; raw?: any; error?: string }> {
  const body: Record<string, any> = {
    symbol: o.symbol, qty: String(o.qty), side: o.side, type: o.type ?? "market", time_in_force: "day",
  };
  if ((o.type ?? "market") === "limit" && o.limitPrice != null) body.limit_price = String(o.limitPrice);

  const res = await alpacaFetch("/v2/orders", o.env, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, brokerOrderId: res.data?.id, raw: res.data };
}

export async function getAlpacaOrder(brokerOrderId: string, env: "paper" | "live"):
  Promise<{ ok: boolean; status?: string; filledQty?: number; avgFillPrice?: number; raw?: any; error?: string }> {
  const res = await alpacaFetch(`/v2/orders/${brokerOrderId}`, env);
  if (!res.ok) return { ok: false, error: res.error };
  const d = res.data;
  const statusMap: Record<string, string> = {
    new: "submitted", accepted: "submitted", pending_new: "submitted",
    partially_filled: "partially_filled", filled: "filled",
    canceled: "canceled", expired: "expired", rejected: "rejected",
  };
  return {
    ok: true, status: statusMap[d?.status] ?? d?.status,
    filledQty: d?.filled_qty != null ? parseFloat(d.filled_qty) : undefined,
    avgFillPrice: d?.filled_avg_price != null ? parseFloat(d.filled_avg_price) : undefined,
    raw: d,
  };
}

export async function cancelAlpacaOrder(brokerOrderId: string, env: "paper" | "live"): Promise<{ ok: boolean; error?: string }> {
  const res = await alpacaFetch(`/v2/orders/${brokerOrderId}`, env, { method: "DELETE" });
  return { ok: res.ok, error: res.error };
}
