import { providerCachedFetch } from "@/lib/data/provider-fetch";

// Alpha Vantage cached fetch — now a thin wrapper over the generic
// providerCachedFetch (lib/data/provider-fetch.ts). Kept as a named export so
// the many existing AV call sites don't churn. All budget/cache/throttle
// semantics live in providerCachedFetch under provider="alpha_vantage".
//
// Usage: const json = await avCachedFetch("RSI:NVDA", url)
// cacheKey uniquely identifies the AV response (function + symbol + key params);
// AV keys are already globally unique (RSI:, OVERVIEW:, GLOBAL_QUOTE:, ...).
export async function avCachedFetch(
  cacheKey: string,
  url: string,
  timeoutMs = 6000,
  headers?: Record<string, string>,
): Promise<any | null> {
  return providerCachedFetch("alpha_vantage", cacheKey, url, { timeoutMs, headers });
}
