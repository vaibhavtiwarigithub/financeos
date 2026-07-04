import { createServiceClient } from "@/lib/supabase/service";

// Alpha Vantage is 25 calls/day (free). This wrapper makes every (function,symbol)
// cost at MOST one real AV call per day, shares that result across all features,
// and — critically — falls back to the last-known payload when AV throttles, so
// downstream inputs stay complete instead of going empty.
//
// Usage: const json = await avCachedFetch("RSI:NVDA", url)
// The cacheKey should uniquely identify the AV response (function + symbol + key params).

// AV signals a rate-limit/throttle via a "Note" or "Information" field (no data).
function isThrottled(json: any): boolean {
  return !!(json && (json.Note || json.Information)) && !json["Global Quote"] && !json["Technical Analysis: RSI"] && !json.Symbol;
}

export async function avCachedFetch(cacheKey: string, url: string, timeoutMs = 6000): Promise<any | null> {
  const svc = createServiceClient();

  // 1. Fresh cache hit for today → no AV call at all.
  const { data: today } = await svc
    .from("av_cache")
    .select("payload")
    .eq("cache_key", cacheKey)
    .eq("cache_date", new Date().toISOString().slice(0, 10))
    .maybeSingle();
  if (today?.payload) return today.payload;

  // 2. Spend one real AV call.
  let json: any = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) json = await res.json();
  } catch { json = null; }

  // 3. Throttled or failed → fall back to the most recent cached payload (any day)
  //    so inputs stay complete rather than empty.
  if (!json || isThrottled(json)) {
    const { data: last } = await svc
      .from("av_cache")
      .select("payload")
      .eq("cache_key", cacheKey)
      .order("cache_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    return last?.payload ?? null;
  }

  // 4. Store today's payload (best-effort) and return it.
  await svc.from("av_cache").upsert(
    { cache_key: cacheKey, cache_date: new Date().toISOString().slice(0, 10), payload: json },
    { onConflict: "cache_key,cache_date" }
  ).then(() => {}, () => {});
  return json;
}
