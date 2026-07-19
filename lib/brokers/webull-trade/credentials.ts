// ============================================================================
// webull_trade — vault-only credential accessor.
// ----------------------------------------------------------------------------
// - Credentials live ONLY in api_key_vault under the provider tag `webull_trade`.
//   They are never read from Settings, never hardcoded, never logged.
// - Sandbox and prod are SEPARATE vault records with SEPARATE key names and
//   SEPARATE hosts. The environment is pinned to the record: a sandbox credential
//   can NEVER resolve a prod host (and vice versa). This is enforced by keying the
//   host off the SAME `env` used to select the vault keys, in one place.
// - The app_key/app_secret/access_token are held in a bounded in-memory cache (short TTL) so a
//   burst of orders does not hammer the vault, but a rotated secret is picked up
//   within the TTL.
// - Nothing here returns, logs, or embeds the secret in an error string.
// ============================================================================

import type { WebullTradeEnv } from "./types";

// Host is pinned to the environment. There is exactly one host per env and the
// mapping is derived from the SAME `env` that selects the credential record, so
// the two can never diverge.
//
// Confirmed against the official Webull SDK/environment reference on 2026-07-19.
// They are host constants only; no request is made in this module.
const HOSTS: Record<WebullTradeEnv, string> = {
  sandbox: "https://api.sandbox.webull.com",
  prod: "https://api.webull.com",
};

// Vault key names per environment. Separate records → a sandbox secret and a prod
// secret can never be confused.
const VAULT_KEYS: Record<WebullTradeEnv, { appKey: string; appSecret: string; accessToken: string }> = {
  sandbox: {
    appKey: "WEBULL_TRADE_SANDBOX_APP_KEY",
    appSecret: "WEBULL_TRADE_SANDBOX_APP_SECRET",
    accessToken: "WEBULL_TRADE_SANDBOX_ACCESS_TOKEN",
  },
  prod: {
    appKey: "WEBULL_TRADE_PROD_APP_KEY",
    appSecret: "WEBULL_TRADE_PROD_APP_SECRET",
    accessToken: "WEBULL_TRADE_PROD_ACCESS_TOKEN",
  },
};

export const VAULT_PROVIDER_TAG = "webull_trade";

export interface WebullTradeCredential {
  env: WebullTradeEnv;
  appKey: string;
  appSecret: string;
  accessToken: string;
  host: string;
}

export type CredentialResult =
  | { ok: true; credential: WebullTradeCredential }
  | { ok: false; error: string };

// Bounded cache: env → { credential, expiresAt }. Default 60s TTL.
const CACHE = new Map<WebullTradeEnv, { credential: WebullTradeCredential; expiresAt: number }>();
const DEFAULT_TTL_MS = 60 * 1000;

export function hostForEnv(env: WebullTradeEnv): string {
  return HOSTS[env];
}

// Assert a URL/host belongs to the pinned environment. Used as a last-line guard
// on the transport so a credential for one env can never be sent to the other's
// host, whatever the caller passed.
export function assertHostMatchesEnv(env: WebullTradeEnv, host: string): boolean {
  return host === HOSTS[env];
}

export function clearCredentialCache(): void {
  CACHE.clear();
}

interface VaultReader {
  // Returns the vault value for a key, or null. Shape mirrors the Supabase
  // service client used elsewhere; injectable for tests so NO network/DB is hit.
  readKey(keyName: string, provider: string): Promise<string | null>;
}

// Default reader over the Supabase service client. Reads BOTH the key name and
// the provider tag, so a value stored under the wrong provider is not accepted.
export function supabaseVaultReader(svc: any): VaultReader {
  return {
    async readKey(keyName: string, provider: string): Promise<string | null> {
      const { data, error } = await svc
        .from("api_key_vault")
        .select("key_value")
        .eq("key_name", keyName)
        .eq("provider", provider)
        .maybeSingle();
      if (error) return null;
      const v = (data as any)?.key_value;
      return typeof v === "string" && v.trim().length > 0 ? v : null;
    },
  };
}

export async function getWebullTradeCredential(
  reader: VaultReader,
  env: WebullTradeEnv,
  opts: { now?: number; ttlMs?: number } = {},
): Promise<CredentialResult> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const cached = CACHE.get(env);
  if (cached && cached.expiresAt > now) {
    return { ok: true, credential: cached.credential };
  }

  const keys = VAULT_KEYS[env];
  const [appKey, appSecret, accessToken] = await Promise.all([
    reader.readKey(keys.appKey, VAULT_PROVIDER_TAG),
    reader.readKey(keys.appSecret, VAULT_PROVIDER_TAG),
    reader.readKey(keys.accessToken, VAULT_PROVIDER_TAG),
  ]);

  // Fail closed WITHOUT echoing any secret material.
  if (!appKey || !appSecret || !accessToken) {
    return {
      ok: false,
      error: `webull_trade ${env} credentials not provisioned in vault (provider='${VAULT_PROVIDER_TAG}')`,
    };
  }

  const credential: WebullTradeCredential = {
    env,
    appKey,
    appSecret,
    accessToken,
    host: HOSTS[env], // host pinned to the SAME env that selected the keys
  };
  CACHE.set(env, { credential, expiresAt: now + ttlMs });
  return { ok: true, credential };
}
