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

// Free-tier ceiling. Configurable so a paid key can raise it. avCachedFetch
// stops spending real calls once the day's count reaches this, serving cached
// payloads instead — so the small handful of highest-value first-of-day fetches
// per symbol land before the budget is exhausted, and nothing throws.
const AV_DAILY_BUDGET = Number(process.env.AV_DAILY_BUDGET ?? 25);

async function lastCached(svc: any, cacheKey: string): Promise<any | null> {
  const { data: last } = await svc
    .from("av_cache")
    .select("payload")
    .eq("cache_key", cacheKey)
    .order("cache_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return last?.payload ?? null;
}

export async function avCachedFetch(cacheKey: string, url: string, timeoutMs = 6000, headers?: Record<string, string>): Promise<any | null> {
  const svc = createServiceClient();
  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. Fresh cache hit for today → no real call at all.
  const { data: today } = await svc
    .from("av_cache")
    .select("payload")
    .eq("cache_key", cacheKey)
    .eq("cache_date", todayStr)
    .maybeSingle();
  if (today?.payload) return today.payload;

  // 2. Budget guard — atomically reserve a call slot for today. If we're over
  //    the daily ceiling, don't spend a real call; serve the last-known payload.
  //    (Reserve-before-spend: a rare over-count is safer than an over-spend.)
  try {
    const { data: count } = await svc.rpc("av_budget_increment", { p_date: todayStr });
    if (typeof count === "number" && count > AV_DAILY_BUDGET) {
      return lastCached(svc, cacheKey);
    }
  } catch { /* counter unavailable → fall through and spend (fail open, cache still limits) */ }

  // 3. Spend one real call.
  let json: any = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    if (res.ok) json = await res.json();
  } catch { json = null; }

  // 4. Throttled or failed → fall back to the most recent cached payload (any day)
  //    so inputs stay complete rather than empty.
  if (!json || isThrottled(json)) {
    return lastCached(svc, cacheKey);
  }

  // 4. Store today's payload (best-effort) and return it.
  await svc.from("av_cache").upsert(
    { cache_key: cacheKey, cache_date: new Date().toISOString().slice(0, 10), payload: json },
    { onConflict: "cache_key,cache_date" }
  ).then(() => {}, () => {});
  return json;
}
