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
  // Days a cached payload stays "fresh" and skips a real AV call. Pass a value
  // for slow-moving data (fundamentals ~14d, news ~2d); omit for daily data.
  maxAgeDays?: number,
  maxStaleAgeDays?: number,
): Promise<any | null> {
  return providerCachedFetch("alpha_vantage", cacheKey, url, { timeoutMs, headers, maxAgeDays, maxStaleAgeDays });
}

// Alpha Vantage has one CSV endpoint (EARNINGS_CALENDAR).  It must use the
// exact same cache and hard reservation as JSON endpoints; raw CSV fetches
// were an unmetered path around the 25-call budget.
export async function avCachedTextFetch(
  cacheKey: string,
  url: string,
  timeoutMs = 6000,
  maxAgeDays?: number,
  maxStaleAgeDays?: number,
): Promise<string | null> {
  const data = await providerCachedFetch("alpha_vantage", cacheKey, url, {
    timeoutMs, maxAgeDays, maxStaleAgeDays, responseType: "text",
    isThrottled: (body) => typeof body === "string" && /"(?:Note|Information)"\s*:/i.test(body),
  });
  return typeof data === "string" ? data : null;
}
