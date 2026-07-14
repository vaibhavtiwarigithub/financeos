import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { providerConfig, type ProviderId } from "@/lib/data/provider-fetch";
import { PROVIDER_SPECS } from "@/lib/evidence/registry";

export const dynamic = "force-dynamic";

// Data Providers capacity dashboard feed. Per provider: limit, today's real
// calls, 7-day average, headroom, credential expiry countdown, and a bottleneck
// flag (which capped provider is closest to its ceiling). "Always know where
// the ceiling is." Owner-only.
//
// EXTENDED for the Canonical Evidence Router: each provider now ALSO reports its
// code-owned capability/limit spec (PROVIDER_SPECS), its DB runtime override
// (provider_runtime_config), its capability maturity/entitlement/contract state
// (provider_capability_status), and a rolling 24h operational summary from the
// append-only call ledger (provider_call_ledger) — cache hit rate, success vs
// schema-rejection counts, consecutive failures, last success, p50 latency.
// All new fields are ADDITIVE; existing fields are unchanged (other UI reads them).
// Read-only via the service client. NO scoring / order / money path is touched.
//
// CRITICAL correction shipped here: a null daily budget no longer implies
// "uncapped/unlimited". The prior response treated every provider with a null
// `dailyBudget` (Yahoo, Webull, Upstox, FRED, GDELT, SEC) as having no cap — a
// lie for providers whose real cap is simply UNPUBLISHED. `dailyLimitState` now
// distinguishes "none" (genuinely no daily cap, rate-limited only — proven by a
// PROVIDER_SPECS entry) from "unknown" (cap exists or may exist, we just don't
// know it). Only a code-owned spec (or an operator override) may assert "none".

// Which env var holds each provider's credential (for key-present + expiry).
const KEY_ENV: Record<ProviderId, string | null> = {
  alpha_vantage: "ALPHA_VANTAGE_API_KEY",
  financialdatasets: "FINANCIAL_DATASETS_API_KEY",
  massive: "MASSIVE_API_KEY",
  finnhub: "FINNHUB_API_KEY",
  fmp: "FMP_API_KEY",
  eodhd: "EODHD_API_KEY",
  twelvedata: "TWELVEDATA_API_KEY",
  upstox: "UPSTOX_ACCESS_TOKEN",
  fred: "FRED_API_KEY",
  gdelt: null, // free, no API key required
  sec: null,   // SEC EDGAR — official, no key
  yahoo: null, // Yahoo quoteSummary — unofficial, no key
  webull: null, // Webull MCP — OAuth token in vault, not an env key
};

type LimitState = "known" | "none" | "unknown";
type EntitlementState = "active" | "inactive" | "unknown";
type ContractState = "valid" | "invalid" | "unverified";

// Least-mature-first ordinal ladder (matches provider_capability_status check).
const MATURITY_ORDER = ["discovered", "contract_valid", "shadow_validated", "production_eligible"] as const;

const LEDGER_WINDOW_MS = 24 * 60 * 60 * 1000;
const CIRCUIT_FAIL_THRESHOLD = 5; // consecutive failures that flip the derived circuit "open"
const MAX_LEDGER_ROWS = 20000;    // bounded read — 24h across ~13 providers, owner-only

// Decode a JWT's `exp` (seconds) without verifying — only for showing an expiry
// countdown for token credentials (Upstox). Returns null for non-JWT keys.
function jwtExpiryIso(token: string | undefined): string | null {
  if (!token || token.split(".").length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
  } catch { return null; }
}

// Resolve the displayed daily-limit state. Precedence: code-owned spec is the
// source of truth; a null provider-fetch budget WITHOUT a spec asserting "none"
// is "unknown" (NOT uncapped). An explicit operator override in
// provider_runtime_config (anything other than the default 'unknown') wins last,
// so an operator can tighten a provider they've since learned has a hidden cap.
function resolveDailyLimitState(budget: number | null, specState: LimitState | undefined, rc: any): LimitState {
  let state: LimitState = specState ?? (budget != null ? "known" : "unknown");
  const override = rc?.daily_limit_state as LimitState | undefined;
  if (override && override !== "unknown") state = override;
  return state;
}

function resolveRateLimitState(specState: LimitState | undefined, rc: any): LimitState {
  let state: LimitState = specState ?? "unknown";
  const override = rc?.rate_limit_state as LimitState | undefined;
  if (override && override !== "unknown") state = override;
  return state;
}

// Collapse the per-(market,intent) capability rows for one provider into a single
// conservative, worst-case-surfaced summary. A health dashboard should show the
// WEAKEST link: "active"/"valid"/"production_eligible" only appear when EVERY row
// qualifies. No rows → unknown/null (provider not yet probed by the router).
function summarizeCapability(rows: any[]): {
  entitlement: EntitlementState;
  contractState: ContractState | null;
  maturityState: string | null;
} {
  if (!rows.length) return { entitlement: "unknown", contractState: null, maturityState: null };

  const ents = rows.map((r) => r.entitlement_state as EntitlementState);
  const entitlement: EntitlementState = ents.includes("inactive")
    ? "inactive"
    : ents.includes("unknown")
      ? "unknown"
      : "active";

  const contracts = rows.map((r) => r.contract_state as ContractState);
  const contractState: ContractState = contracts.includes("invalid")
    ? "invalid"
    : contracts.includes("unverified")
      ? "unverified"
      : "valid";

  // Weakest maturity = smallest ordinal on the ladder.
  const minMaturity = rows.reduce((min, r) => {
    const idx = MATURITY_ORDER.indexOf(r.maturity_state);
    return idx >= 0 && idx < min ? idx : min;
  }, MATURITY_ORDER.length - 1);

  return { entitlement, contractState, maturityState: MATURITY_ORDER[minMaturity] ?? null };
}

// Roll up the last ~24h of call-ledger rows (already ordered newest-first) for one
// provider into an operational summary. Null when the provider has no ledger rows
// yet (the router hasn't run it) — never an error.
function summarizeLedger(rows: any[]): {
  rows: number;
  cacheOutcome: { fresh: number; stale: number; miss: number };
  cacheHitRate: number | null; // (fresh+stale)/(fresh+stale+miss), null if no cache-tagged rows
  successCount: number;
  schemaRejectCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  p50LatencyMs: number | null;
} | null {
  if (!rows.length) return null;

  const cacheOutcome = { fresh: 0, stale: 0, miss: 0 };
  let successCount = 0, schemaRejectCount = 0, failureCount = 0, consecutiveFailures = 0;
  let stillConsecutive = true;
  let lastSuccessAt: string | null = null;
  const latencies: number[] = [];

  for (const r of rows) {
    if (r.cache_outcome === "fresh") cacheOutcome.fresh++;
    else if (r.cache_outcome === "stale") cacheOutcome.stale++;
    else if (r.cache_outcome === "miss") cacheOutcome.miss++;

    const failed = r.error_code != null;
    if (failed) {
      failureCount++;
      if (r.error_code === "schema_invalid") schemaRejectCount++;
      if (stillConsecutive) consecutiveFailures++;
    } else {
      successCount++;
      stillConsecutive = false; // first non-failure (rows are newest-first) closes the streak
      if (!lastSuccessAt) lastSuccessAt = (r.completed_at ?? r.created_at) ?? null;
    }

    if (typeof r.latency_ms === "number") latencies.push(r.latency_ms);
  }

  const cacheTagged = cacheOutcome.fresh + cacheOutcome.stale + cacheOutcome.miss;
  const cacheHitRate = cacheTagged > 0
    ? Math.round(((cacheOutcome.fresh + cacheOutcome.stale) / cacheTagged) * 1000) / 1000
    : null;

  let p50LatencyMs: number | null = null;
  if (latencies.length) {
    latencies.sort((a, b) => a - b);
    p50LatencyMs = latencies[Math.floor((latencies.length - 1) / 2)];
  }

  return {
    rows: rows.length,
    cacheOutcome,
    cacheHitRate,
    successCount,
    schemaRejectCount,
    failureCount,
    consecutiveFailures,
    lastSuccessAt,
    p50LatencyMs,
  };
}

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const cfg = providerConfig();
  const today = new Date().toISOString().slice(0, 10);
  const sinceIso = new Date(Date.now() - LEDGER_WINDOW_MS).toISOString();

  // FinancialDatasets key may live in the vault rather than env — check both,
  // instead of assuming it's present (the scanner silently returns no
  // candidates if the key is actually missing).
  let fdKeyPresent = !!process.env.FINANCIAL_DATASETS_API_KEY;
  if (!fdKeyPresent) {
    try {
      const { data } = await svc.from("api_key_vault").select("key_value").eq("key_name", "FINANCIAL_DATASETS_API_KEY").maybeSingle();
      fdKeyPresent = !!(data as any)?.key_value;
    } catch { /* leave false */ }
  }

  // Existing budget rollups + the three Evidence-Router runtime tables. Each new
  // read is independently fault-isolated (a missing table/permission → empty, not
  // a 500), so the capacity view degrades to "no runtime data" gracefully.
  const [
    { data: todayRows },
    { data: avgRows },
    runtimeCfg,
    capStatus,
    ledger,
  ] = await Promise.all([
    svc.from("provider_budget").select("provider, calls").eq("cache_date", today),
    svc.from("provider_budget_7d").select("provider, avg_calls_7d, peak_calls_7d, days_seen"),
    svc.from("provider_runtime_config")
      .select("provider_id, enabled, daily_limit_state, daily_limit_override, rate_limit_state, rate_limit_calls_override, rate_window_seconds_override, min_interval_ms_override, reserve_calls_override, updated_at")
      .then((r: any) => r, () => ({ data: null })),
    svc.from("provider_capability_status")
      .select("provider_id, market, intent, contract_state, maturity_state, entitlement_state")
      .then((r: any) => r, () => ({ data: null })),
    svc.from("provider_call_ledger")
      .select("provider, cache_outcome, error_code, latency_ms, completed_at, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(MAX_LEDGER_ROWS)
      .then((r: any) => r, () => ({ data: null })),
  ]);

  const todayByProv = new Map((todayRows ?? []).map((r: any) => [r.provider, r.calls]));
  const avgByProv = new Map((avgRows ?? []).map((r: any) => [r.provider, r]));
  const rcByProv = new Map(((runtimeCfg as any)?.data ?? []).map((r: any) => [r.provider_id, r]));

  const capByProv = new Map<string, any[]>();
  for (const row of ((capStatus as any)?.data ?? []) as any[]) {
    const arr = capByProv.get(row.provider_id) ?? [];
    arr.push(row);
    capByProv.set(row.provider_id, arr);
  }

  const ledgerByProv = new Map<string, any[]>();
  for (const row of ((ledger as any)?.data ?? []) as any[]) {
    const arr = ledgerByProv.get(row.provider) ?? [];
    arr.push(row); // preserves newest-first order from the query
    ledgerByProv.set(row.provider, arr);
  }

  const providers = (Object.keys(cfg) as ProviderId[]).map((id) => {
    const c = cfg[id];
    const spec = PROVIDER_SPECS[id];
    const rc = rcByProv.get(id) as any;
    const envName = KEY_ENV[id];
    const keyVal = envName ? process.env[envName] : undefined;
    const keyPresent = id === "financialdatasets" ? fdKeyPresent : !!keyVal;
    const expiresAt = jwtExpiryIso(keyVal);
    const daysToExpiry = expiresAt ? Math.round((new Date(expiresAt).getTime() - Date.now()) / 86400000) : null;
    const todayCalls = Number(todayByProv.get(id) ?? 0);
    const avg = avgByProv.get(id) as any;
    const avg7d = Number(avg?.avg_calls_7d ?? 0);
    const limit = c.dailyBudget; // null = no daily cap (rate-limited only)
    const headroom = limit != null ? Math.max(0, limit - todayCalls) : null;
    const pctUsed = limit != null && limit > 0 ? Math.round((todayCalls / limit) * 100) : null;

    // ── Evidence-Router additive fields ──────────────────────────────────────
    const dailyLimitState = resolveDailyLimitState(c.dailyBudget, spec?.dailyLimitState, rc);
    const rateLimitState = resolveRateLimitState(spec?.rateLimitState, rc);
    // Only surface a concrete daily-limit NUMBER when the state is "known" — an
    // "unknown" or "none" state must never be rendered as a number (that was the
    // original lie). Prefer an operator override, then the spec, then the budget.
    const dailyLimit = dailyLimitState === "known"
      ? Number(rc?.daily_limit_override ?? spec?.dailyLimit ?? c.dailyBudget ?? 0) || null
      : null;

    const cap = summarizeCapability(capByProv.get(id) ?? []);
    const ledger24h = summarizeLedger(ledgerByProv.get(id) ?? []);
    const enabled = rc?.enabled ?? null;

    // Derived circuit indicator (no dedicated column exists): "open" when an
    // operator has disabled the provider OR it has a run of consecutive failures;
    // "closed" when it has ledger activity and is healthy; "unknown" with no data.
    let circuitState: "open" | "closed" | "unknown" = "unknown";
    if (enabled === false) circuitState = "open";
    else if (ledger24h) circuitState = ledger24h.consecutiveFailures >= CIRCUIT_FAIL_THRESHOLD ? "open" : "closed";

    return {
      id, label: c.label,
      keyPresent,
      limit,                         // daily cap or null (rate-limited) — LEGACY: null does NOT mean uncapped, read dailyLimitState
      todayCalls,
      avg7d,
      peak7d: Number(avg?.peak_calls_7d ?? 0),
      headroom,
      pctUsed,                       // % of daily cap used today (null if uncapped)
      expiresAt, daysToExpiry,       // credential expiry (null = never)

      // ── additive: capacity / entitlement / contract / circuit ──────────────
      dailyLimitState,               // "known" | "none" | "unknown" — null≠unlimited fix
      rateLimitState,                // "known" | "none" | "unknown"
      dailyLimit,                    // concrete cap ONLY when dailyLimitState === "known", else null
      rateLimit: spec && spec.rateLimitState === "known" && spec.rateLimitCalls != null
        ? { calls: spec.rateLimitCalls, windowSeconds: spec.rateLimitWindowSeconds ?? null }
        : null,
      minIntervalMs: Number(rc?.min_interval_ms_override ?? spec?.minIntervalMs ?? 0) || null,
      capabilities: spec?.capabilities ?? [],
      markets: spec?.markets ?? [],
      entitlementRequired: spec?.entitlementRequired ?? null,
      entitlement: cap.entitlement,          // "active" | "inactive" | "unknown"
      contractState: cap.contractState,      // "valid" | "invalid" | "unverified" | null
      maturityState: cap.maturityState,      // least-mature across probed intents, or null
      trustTier: spec?.trustTier ?? null,
      official: spec?.official ?? null,
      enabled,                               // provider_runtime_config.enabled (null = no override row)
      circuitState,                          // derived: "open" | "closed" | "unknown"
      ledger24h,                             // rolling 24h call summary, or null if never called
    };
  });

  // Bottleneck = capped provider closest to its ceiling (highest pctUsed today).
  const capped = providers.filter((p) => p.pctUsed != null);
  const bottleneck = capped.length ? capped.reduce((a, b) => (b.pctUsed! > a.pctUsed! ? b : a)) : null;

  return NextResponse.json({
    providers,
    bottleneck: bottleneck ? { id: bottleneck.id, label: bottleneck.label, pctUsed: bottleneck.pctUsed } : null,
    // Runtime-state provenance so the UI can caption "as of" for the new fields.
    ledgerWindowHours: 24,
    as_of: new Date().toISOString(),
  });
}
