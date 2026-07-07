import { createServiceClient } from "@/lib/supabase/service";
import { reportIssue, resolveIssue } from "@/lib/system-health";

// Start of the next UTC day — an AV-budget alert self-clears when the quota resets.
function nextUtcMidnight(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

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

// Serving an arbitrarily old cached payload as if it were current data is its
// own failure mode — a symbol nobody's fetched in weeks (budget exhausted or
// throttled every day since) would silently return real-looking-but-ancient
// insider/fundamental data with no signal that it's stale. Cap the fallback.
const MAX_STALE_CACHE_DAYS = 7;

async function lastCached(svc: any, cacheKey: string): Promise<any | null> {
  const { data: last } = await svc
    .from("av_cache")
    .select("payload, cache_date")
    .eq("cache_key", cacheKey)
    .order("cache_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!last?.payload) return null;
  const ageDays = (Date.now() - new Date(last.cache_date).getTime()) / 86400000;
  if (ageDays > MAX_STALE_CACHE_DAYS) return null;
  return last.payload;
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
    const { data: count, error } = await svc.rpc("av_budget_increment", { p_date: todayStr });
    // Fail CLOSED for free-tier preservation: if the counter is unavailable we
    // can't prove we're under budget, so serve the last cached payload rather
    // than risk blowing the 25/day cap. (Freshness degrades gracefully; the
    // quota does not get silently exhausted.)
    if (error) return lastCached(svc, cacheKey);
    if (typeof count === "number" && count > AV_DAILY_BUDGET) {
      // Quota spent for the day — surface it so the user knows scoring inputs
      // are running on cached (staler) data. Self-clears at the next UTC reset.
      await reportIssue({
        issueKey: "av-budget-exhausted",
        severity: "warn", category: "data",
        title: "Alpha Vantage daily budget exhausted",
        detail: `Used ${count}/${AV_DAILY_BUDGET} AV calls today. Further fetches serve cached payloads until the quota resets (00:00 UTC). Scoring inputs may be staler than usual.`,
        autoExpireAt: nextUtcMidnight(),
      }, svc);
      return lastCached(svc, cacheKey);
    }
  } catch { return lastCached(svc, cacheKey); }

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
