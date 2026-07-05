import crypto from "crypto";
import { createServiceClient } from "@/lib/supabase/service";

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

// Authenticated GET against the Kite REST API using the stored daily token.
export async function kiteGet(path: string, svc?: any): Promise<{ ok: boolean; data?: any; error?: string }> {
  const s = svc ?? createServiceClient();
  const { apiKey } = await getKiteCreds(s);
  const { token, fresh } = await getAccessToken(s);
  if (!apiKey || !token) return { ok: false, error: "Kite not connected — log in via /api/kite/login" };
  if (!fresh) return { ok: false, error: "Kite token expired (daily) — re-login via /api/kite/login" };
  try {
    const res = await fetch(`https://api.kite.trade${path}`, {
      headers: { "X-Kite-Version": "3", Authorization: `token ${apiKey}:${token}` },
    });
    const json = await res.json();
    if (!res.ok || json?.status !== "success") return { ok: false, error: json?.message ?? `Kite ${res.status}` };
    return { ok: true, data: json.data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
