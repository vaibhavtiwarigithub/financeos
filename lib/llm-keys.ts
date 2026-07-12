// Settings-LLM Part 2 — vault-backed provider API keys.
//
// Provider keys (Anthropic / DeepSeek / Groq) can be set from Settings and are
// stored in the api_key_vault table (service-role-locked, same store as the
// broker tokens). Resolution is VAULT-FIRST, ENV-FALLBACK: a key set in Settings
// wins; if none is set, the existing process.env.* key is used unchanged — so
// nothing breaks for a deployment that only has env keys.
//
// Security contract: keys are WRITE-ONLY from the UI. Nothing here returns a raw
// key to any caller except the router's own provider calls. getProviderKeyStatus
// exposes only {source, last4} — never the secret. Never log the value.

import { createServiceClient } from "@/lib/supabase/service";

export type LLMProvider = "anthropic" | "deepseek" | "groq" | "gemini" | "grok";

interface ProviderMeta { vaultKey: string; envVar: string; label: string }

export const LLM_PROVIDERS: Record<LLMProvider, ProviderMeta> = {
  anthropic: { vaultKey: "llm_key_anthropic", envVar: "ANTHROPIC_API_KEY", label: "Anthropic (Claude)" },
  deepseek:  { vaultKey: "llm_key_deepseek",  envVar: "DEEPSEEK_API_KEY",  label: "DeepSeek" },
  groq:      { vaultKey: "llm_key_groq",      envVar: "GROQ_API_KEY",      label: "Groq (Llama)" },
  gemini:    { vaultKey: "llm_key_gemini",    envVar: "GEMINI_API_KEY",    label: "Google (Gemini)" },
  grok:      { vaultKey: "llm_key_grok",      envVar: "XAI_API_KEY",       label: "xAI (Grok)" },
};

export function isLLMProvider(x: string): x is LLMProvider {
  return x in LLM_PROVIDERS;
}

// Map a concrete model id to its provider (mirrors the router's dispatch rules).
export function providerForModel(model: string): LLMProvider | null {
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("deepseek")) return "deepseek";
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("grok")) return "grok";
  if (/^(llama|mixtral|gemma|deepseek-r1-distill)/.test(model)) return "groq";
  return null;
}

// ── in-process cache so a vault-backed key is not a DB read on every LLM call ──
// 60s TTL: a rotated key propagates within a minute. Keyed by provider.
const CACHE_TTL_MS = 60_000;
const _cache = new Map<LLMProvider, { value: string | null; exp: number }>();

async function vaultRead(svc: any, keyName: string): Promise<string | null> {
  try {
    const { data } = await svc.from("api_key_vault").select("key_value").eq("key_name", keyName).maybeSingle();
    const v = (data as any)?.key_value;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a provider API key: vault first (cached), then process.env fallback.
 * Returns null only when neither is configured. Never logs the value.
 */
export async function getProviderKey(provider: LLMProvider, svc?: any): Promise<string | null> {
  const now = Date.now();
  const cached = _cache.get(provider);
  if (cached && cached.exp > now) {
    return cached.value ?? (process.env[LLM_PROVIDERS[provider].envVar] || null);
  }
  const client = svc ?? createServiceClient();
  const vaultVal = await vaultRead(client, LLM_PROVIDERS[provider].vaultKey);
  _cache.set(provider, { value: vaultVal, exp: now + CACHE_TTL_MS });
  return vaultVal ?? (process.env[LLM_PROVIDERS[provider].envVar] || null);
}

// Invalidate the cache immediately after a set/clear so the UI reflects reality.
export function invalidateProviderKeyCache(provider?: LLMProvider) {
  if (provider) _cache.delete(provider);
  else _cache.clear();
}

const last4 = (s: string) => (s.length >= 4 ? s.slice(-4) : "••••");

export interface ProviderKeyStatus {
  provider: LLMProvider;
  label: string;
  source: "vault" | "env" | "none";
  last4: string | null;
}

/** Per-provider status for the Settings UI. NEVER includes the raw key. */
export async function getProviderKeyStatus(svc?: any): Promise<ProviderKeyStatus[]> {
  const client = svc ?? createServiceClient();
  const out: ProviderKeyStatus[] = [];
  for (const p of Object.keys(LLM_PROVIDERS) as LLMProvider[]) {
    const meta = LLM_PROVIDERS[p];
    const vaultVal = await vaultRead(client, meta.vaultKey);
    const envVal = process.env[meta.envVar] || null;
    const source: ProviderKeyStatus["source"] = vaultVal ? "vault" : envVal ? "env" : "none";
    const raw = vaultVal ?? envVal;
    out.push({ provider: p, label: meta.label, source, last4: raw ? last4(raw) : null });
  }
  return out;
}

/** Owner-only. Upsert a provider key into the vault. Never logs the value. */
export async function setProviderKey(svc: any, provider: LLMProvider, key: string): Promise<void> {
  const meta = LLM_PROVIDERS[provider];
  const { error } = await svc.from("api_key_vault").upsert(
    { key_name: meta.vaultKey, key_value: key, display_name: `${meta.label} API key`, provider: "llm" },
    { onConflict: "key_name" }
  );
  if (error) throw new Error(`vault write failed for ${meta.vaultKey}: ${error.message}`);
  invalidateProviderKeyCache(provider);
}

/** Owner-only. Remove a vault key so resolution reverts to the env var. */
export async function clearProviderKey(svc: any, provider: LLMProvider): Promise<void> {
  const meta = LLM_PROVIDERS[provider];
  const { error } = await svc.from("api_key_vault").delete().eq("key_name", meta.vaultKey);
  if (error) throw new Error(`vault delete failed for ${meta.vaultKey}: ${error.message}`);
  invalidateProviderKeyCache(provider);
}
