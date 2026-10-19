import { createServiceClient } from "@/lib/supabase/service";

export type AlpacaEnvironment = "paper" | "live";

/**
 * Resolve one complete Alpaca credential pair. The server-side Vault is
 * authoritative when a non-empty value exists; local/deployment environment
 * variables are the fallback. Never log or return these values to the client.
 */
export async function getAlpacaCredentials(env: AlpacaEnvironment): Promise<{ key: string; secret: string } | null> {
  const paper = env === "paper";
  const keyNames = paper ? ["ALPACA_PAPER_API_KEY"] : ["ALPACA_LIVE_API_KEY", "ALPACA_API_KEY"];
  const secretNames = paper ? ["ALPACA_PAPER_API_SECRET"] : ["ALPACA_LIVE_API_SECRET", "ALPACA_API_SECRET"];
  const sb = createServiceClient();

  async function resolve(names: string[], envNames: string[]): Promise<string | null> {
    for (const name of names) {
      const { data } = await sb.from("api_key_vault").select("key_value").eq("key_name", name).maybeSingle();
      if (typeof data?.key_value === "string" && data.key_value.trim()) return data.key_value.trim();
    }
    for (const name of envNames) {
      const value = process.env[name]?.trim();
      if (value) return value;
    }
    return null;
  }

  // Canonical live names are preferred; legacy names remain a compatibility
  // fallback. Paper and Live never borrow credentials from one another.
  const [key, secret] = await Promise.all([
    resolve(keyNames, keyNames),
    resolve(secretNames, secretNames),
  ]);

  if (!key || !secret) return null;
  return { key, secret };
}

/** Ready means at least one environment has both halves of its credential pair. */
export async function isAlpacaConfigured(): Promise<boolean> {
  const paper = await getAlpacaCredentials("paper");
  if (paper) return true;
  return !!(await getAlpacaCredentials("live"));
}
