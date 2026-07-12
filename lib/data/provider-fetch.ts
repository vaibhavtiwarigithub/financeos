import { createServiceClient } from "@/lib/supabase/service";
import { reportIssue } from "@/lib/system-health";

// Generic per-provider cached fetch + daily budget guard. Generalizes the
// original AV-only avCachedFetch (lib/av-cache.ts) so each external data
// provider has its OWN daily budget counter (migration 100) — a
// FinancialDatasets call no longer eats an Alpha Vantage slot.
//
// Response cache stays in av_cache (keyed by a globally-unique, provider-
// prefixed cache_key). Only the BUDGET is per-provider. Semantics preserved
// from the original: reserve-before-spend, fail-closed on counter error, serve
// last-known cached payload (<=7 days old) on throttle/over-budget/failure so a
// downstream scoring input degrades to "stale" rather than "empty".

export type ProviderId =
  | "alpha_vantage" | "financialdatasets" | "massive" | "finnhub"
  | "fmp" | "eodhd" | "twelvedata" | "upstox" | "fred";

interface ProviderConfig {
  label: string;
  // Daily real-call ceiling. null = no daily cap (provider is rate-limited
  // per-minute instead; we don't day-cap those, the per-call cache already
  // collapses repeat symbols). Env override lets a paid tier raise it.
  dailyBudget: number | null;
}

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  alpha_vantage:     { label: "Alpha Vantage",     dailyBudget: Number(process.env.AV_DAILY_BUDGET ?? 25) },
  financialdatasets: { label: "FinancialDatasets", dailyBudget: Number(process.env.FD_DAILY_BUDGET ?? 200) },
  fmp:               { label: "FMP",               dailyBudget: Number(process.env.FMP_DAILY_BUDGET ?? 240) }, // 250/day free, keep headroom
  twelvedata:        { label: "Twelve Data",       dailyBudget: Number(process.env.TWELVEDATA_DAILY_BUDGET ?? 750) }, // 800/day free
  eodhd:             { label: "EODHD",             dailyBudget: Number(process.env.EODHD_DAILY_BUDGET ?? 20) }, // free tier; paid users must opt in via env
  finnhub:           { label: "Finnhub",           dailyBudget: null }, // 60/min, no daily cap
  massive:           { label: "Massive",           dailyBudget: null }, // 5/min, no daily cap
  upstox:            { label: "Upstox",            dailyBudget: null }, // ~500/min, no daily cap
  fred:              { label: "FRED",              dailyBudget: null }, // rate-limited only
};

// AV signals a rate-limit/throttle via a "Note" or "Information" field (no data).
function avThrottled(json: any): boolean {
  return !!(json && (json.Note || json.Information)) && !json["Global Quote"] && !json["Technical Analysis: RSI"] && !json.Symbol;
}

const MAX_STALE_CACHE_DAYS = 7;

function nextUtcMidnight(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

// Most-recent cached payload for a key, if it is at most `maxDays` old. Used both
// for the throttle/over-budget fallback (7d) and — when a caller passes
// opts.maxAgeDays — as a FRESH hit that skips the real call entirely, so
// slow-moving data (fundamentals) isn't re-fetched every single day.
async function lastCached(svc: any, cacheKey: string, maxDays = MAX_STALE_CACHE_DAYS): Promise<any | null> {
  const { data: last } = await svc
    .from("av_cache")
    .select("payload, cache_date")
    .eq("cache_key", cacheKey)
    .order("cache_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!last?.payload) return null;
  const ageDays = (Date.now() - new Date(last.cache_date).getTime()) / 86400000;
  if (ageDays > maxDays) return null;
  return last.payload;
}

export interface ProviderFetchOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
  // Provider-specific "this response is a throttle/error, not real data" check.
  // Defaults to AV-style for alpha_vantage, and "never" for the rest (their
  // errors are HTTP-status/JSON-shape specific and handled by the caller).
  isThrottled?: (json: any) => boolean;
  // Freshness window in days. When >0, a cached payload up to this many days old
  // is served as a hit WITHOUT spending a real provider call — for slow-moving
  // data (fundamentals ~14d, news ~2d) that need not be re-fetched daily. Default
  // 0 = today-only (re-fetch each day), preserving prior behavior for prices/quotes.
  maxAgeDays?: number;
}

// Cache key MUST be globally unique across providers. Callers pass a
// provider-prefixed key (e.g. "FMP_PROFILE:AAPL", "FINNHUB_NEWS:AAPL").
export async function providerCachedFetch(
  provider: ProviderId,
  cacheKey: string,
  url: string,
  opts: ProviderFetchOpts = {},
): Promise<any | null> {
  const svc = createServiceClient();
  const cfg = PROVIDERS[provider];
  const todayStr = new Date().toISOString().slice(0, 10);
  const timeoutMs = opts.timeoutMs ?? 6000;
  const isThrottled = opts.isThrottled ?? (provider === "alpha_vantage" ? avThrottled : () => false);

  // 1. Fresh cache hit → no real call. Slow-moving data (fundamentals/news) passes
  // maxAgeDays>0 so a payload up to N days old counts as fresh and skips the call —
  // the single biggest AV-budget saver, since the same symbols are scored daily but
  // their fundamentals change quarterly. Default 0 = today-only (prices/quotes).
  const maxAgeDays = opts.maxAgeDays ?? 0;
  if (maxAgeDays > 0) {
    const fresh = await lastCached(svc, cacheKey, maxAgeDays);
    if (fresh) return fresh;
  } else {
    const { data: today } = await svc
      .from("av_cache")
      .select("payload")
      .eq("cache_key", cacheKey)
      .eq("cache_date", todayStr)
      .maybeSingle();
    if (today?.payload) return today.payload;
  }

  // 2. Budget guard (only for providers with a daily cap). Reserve-before-spend.
  if (cfg.dailyBudget != null) {
    try {
      const { data: count, error } = await svc.rpc("provider_budget_increment", { p_provider: provider, p_date: todayStr });
      if (error) return lastCached(svc, cacheKey); // fail closed
      if (typeof count === "number" && count > cfg.dailyBudget) {
        await reportIssue({
          issueKey: `provider-budget-exhausted:${provider}`,
          severity: "warn", category: "data",
          title: `${cfg.label} daily budget exhausted`,
          detail: `Used ${count}/${cfg.dailyBudget} ${cfg.label} calls today. Further fetches serve cached payloads until the quota resets (00:00 UTC). Scoring inputs may be staler than usual.`,
          autoExpireAt: nextUtcMidnight(),
        }, svc);
        return lastCached(svc, cacheKey);
      }
    } catch { return lastCached(svc, cacheKey); }
  } else {
    // No daily cap: still log the call so the capacity dashboard shows real
    // usage/averages. Awaited (non-fatal) so a serverless function that
    // terminates right after the response doesn't drop the increment — a
    // fire-and-forget promise can be lost before it flushes, undercounting
    // Massive/Finnhub/Upstox/FRED usage.
    try { await svc.rpc("provider_budget_increment", { p_provider: provider, p_date: todayStr }); } catch { /* never block the fetch on logging */ }
  }

  // 3. Spend one real call.
  let json: any = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: opts.headers });
    if (res.ok) json = await res.json();
  } catch { json = null; }

  // 4. Throttled/failed → last-known cached payload (<=7d) so inputs stay complete.
  // CARRY-FORWARD: persist that payload into TODAY's slot so the next same-day call
  // for this key is a step-1 cache hit and does NOT re-spend a (throttled) call.
  // This is what stops the retry storm — previously a throttled key was re-fetched
  // (and re-counted against budget) on every research pass all day, inflating a
  // handful of real keys into ~200 "calls". Only writes when we actually have a
  // prior payload; a brand-new symbol with no history still just returns null.
  if (!json || isThrottled(json)) {
    const carried = await lastCached(svc, cacheKey);
    if (carried != null) {
      await svc.from("av_cache").upsert(
        { cache_key: cacheKey, cache_date: todayStr, payload: carried },
        { onConflict: "cache_key,cache_date" },
      ).then(() => {}, () => {});
    }
    return carried;
  }

  // 5. Store today's payload (best-effort) and return it.
  await svc.from("av_cache").upsert(
    { cache_key: cacheKey, cache_date: todayStr, payload: json },
    { onConflict: "cache_key,cache_date" },
  ).then(() => {}, () => {});
  return json;
}

export function providerConfig(): Record<ProviderId, ProviderConfig> {
  return PROVIDERS;
}
