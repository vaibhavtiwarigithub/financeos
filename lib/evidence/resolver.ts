// Canonical Evidence Router — resolver (Phase 2 engine).
//
// evidenceRouter.resolve({market,symbol,intent,asOf,runId}) returns a canonical
// EvidenceEnvelope. Deterministic — NO LLM. Fail-closed: any timeout / invalid
// payload / no-slot / policy-off returns an `unavailable` (or `stale`) envelope,
// NEVER a fabricated neutral value.
//
// This engine is CALLABLE but NOTHING in the money path consumes it yet — the
// per-market active policy ships with router_enabled=false, so wiring it into
// research is a separate, gated dual-run step. It writes only its own canonical
// cache (evidence_cache_v2) + append-only call ledger; it never touches scores,
// cash, positions, proposals, or orders.
//
// Resolution (arch §9): validate/applicability → load frozen policy → build
// candidate chain (registry order, policy mode, runtime-disabled removed) → read
// fresh canonical cache → on miss, acquire pacing/budget lease for at most TWO
// synchronous attempts → validate + canonicalize → persist cache + ledger. If no
// slot: serve policy-allowed stale + enqueue a refresh job. Never spin-wait.

import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import {
  INTENT_CATALOG,
  isEvidenceIntent,
  isMarket,
  type EvidenceEnvelope,
  type EvidenceIntent,
  type EvidenceQuality,
  type FieldProvenance,
  type Market,
  type ProviderAdapter,
  type ProviderId,
  type UnavailableReason,
} from "@/lib/evidence/contracts";
import { adaptersForIntent, PROVIDER_SPECS } from "@/lib/evidence/registry";

const MARKET_SYMBOL = "__MARKET__";     // reserved symbol for market-wide intents
const MAX_SYNC_ATTEMPTS = 2;            // hard Vercel wall-clock bound
const SCHEMA_VERSION = "evidence-v1";

export interface ResolveRequest {
  market: Market;
  intent: EvidenceIntent;
  symbol?: string;
  asOf?: string;   // ISO; defaults to now. Used for provenance + freshness.
  runId?: string;
  timeoutMs?: number;
  // Shadow collection may exercise an inactive policy. Every other caller is
  // blocked while router_enabled=false, preventing accidental pre-cutover use.
  allowDisabledPolicy?: boolean;
  /** Evaluation-only mode: read canonical cache but never lease/call/enqueue. */
  cacheOnly?: boolean;
  /** Exact inactive candidate policy; allowed only for cache-only shadow evaluation. */
  policyVersionId?: string;
}

interface PolicyRule {
  mode: "auto" | "prefer" | "only" | "off";
  preferred_provider: string | null;
  policy_version_id: string;
  router_enabled: boolean;
  max_age_seconds: number;
  stale_max_seconds: number;
  max_sync_attempts: number;
}

interface RuntimeConfig {
  enabled: boolean;
  min_interval_ms_override: number | null;
}

export function evidenceFingerprint(intent: string, market: string, symbol: string, contractVersion: string): string {
  return createHash("sha1").update(`${intent}|${market}|${symbol}|${contractVersion}`).digest("hex").slice(0, 24);
}

function envelope<T>(
  base: Pick<ResolveRequest, "market" | "intent" | "symbol">,
  policyVersionId: string,
  quality: EvidenceQuality,
  cacheState: "fresh" | "stale" | "miss",
  payload: T | null,
  provenance: FieldProvenance[],
  attempted: ProviderId[],
  reason?: UnavailableReason,
): EvidenceEnvelope<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    market: base.market,
    symbol: base.symbol,
    intent: base.intent,
    quality,
    payload,
    provenance,
    providersAttempted: attempted,
    policyVersionId,
    cacheState,
    unavailableReason: reason,
    resolvedAt: new Date().toISOString(),
  };
}

// Missing policy state is unsafe: migrations seed both markets, so a lookup
// failure must not silently invent an Auto policy.
async function loadRule(
  svc: any,
  market: Market,
  intent: EvidenceIntent,
  requestedVersionId?: string,
): Promise<PolicyRule | null> {
  let policyVersionId = requestedVersionId;
  if (!policyVersionId) {
    const { data: ptr, error: ptrError } = await svc
      .from("active_evidence_policy")
      .select("policy_version_id")
      .eq("market", market)
      .maybeSingle();
    if (ptrError) throw new Error("active policy lookup failed");
    policyVersionId = ptr?.policy_version_id;
  }
  if (!policyVersionId) return null;
  const [{ data: version, error: versionError }, { data: rule, error: ruleError }] = await Promise.all([
    svc.from("evidence_policy_versions")
      .select("router_enabled")
      .eq("id", policyVersionId)
      .eq("market", market)
      .maybeSingle(),
    svc.from("evidence_policy_rules")
      .select("mode, preferred_provider, policy_version_id, max_age_seconds, stale_max_seconds, max_sync_attempts")
      .eq("policy_version_id", policyVersionId)
      .eq("intent", intent)
      .maybeSingle(),
  ]);
  if (versionError || ruleError) throw new Error("active policy rule lookup failed");
  if (!version || !rule) return null;
  return { ...rule, router_enabled: version.router_enabled } as PolicyRule;
}

// Order the registry chain per policy mode. off → []. only → [preferred]. prefer
// → preferred first then the rest. auto → registry order.
function applyMode(chain: ProviderAdapter[], rule: PolicyRule | null): ProviderAdapter[] {
  if (!rule || rule.mode === "auto") return chain;
  if (rule.mode === "off") return [];
  const pref = chain.filter((a) => a.providerId === rule.preferred_provider);
  if (rule.mode === "only") return pref;
  return [...pref, ...chain.filter((a) => a.providerId !== rule.preferred_provider)];
}

async function loadRuntimeConfig(svc: any): Promise<Map<string, RuntimeConfig>> {
  const { data, error } = await svc
    .from("provider_runtime_config")
    .select("provider_id, enabled, min_interval_ms_override");
  if (error) throw new Error("provider runtime config lookup failed");
  return new Map((data ?? []).map((r: any) => [r.provider_id, {
    enabled: r.enabled !== false,
    min_interval_ms_override: Number.isFinite(Number(r.min_interval_ms_override))
      ? Number(r.min_interval_ms_override)
      : null,
  }]));
}

// Best-effort append to the call ledger. Never throws — audit must never block.
async function ledger(svc: any, row: Record<string, unknown>): Promise<void> {
  try { await svc.from("provider_call_ledger").insert(row); } catch { /* audit is non-critical */ }
}

export async function resolveEvidence<T = unknown>(req: ResolveRequest): Promise<EvidenceEnvelope<T>> {
  const svc = createServiceClient();
  const market = req.market;
  const intent = req.intent;
  const symbol = (req.symbol ?? MARKET_SYMBOL).toUpperCase();
  const base = { market, intent, symbol: req.symbol };
  const timeoutMs = req.timeoutMs ?? 6000;

  // 1. validate + structural applicability
  if (!isMarket(market) || !isEvidenceIntent(intent)) {
    return envelope<T>(base, "", "unavailable", "miss", null, [], [], "schema_invalid");
  }
  if (req.policyVersionId && (!req.cacheOnly || !req.allowDisabledPolicy)) {
    return envelope<T>(base, "", "unavailable", "miss", null, [], [], "disabled_by_policy");
  }
  const spec = INTENT_CATALOG[intent];
  if (!spec.markets.includes(market)) {
    return envelope<T>(base, "", "not_applicable", "miss", null, [], [], "not_applicable");
  }

  // 2. frozen policy
  let rule: PolicyRule | null;
  let runtime: Map<string, RuntimeConfig>;
  try {
    [rule, runtime] = await Promise.all([
      loadRule(svc, market, intent, req.policyVersionId),
      loadRuntimeConfig(svc),
    ]);
  } catch {
    return envelope<T>(base, "", "unavailable", "miss", null, [], [], "provider_error");
  }
  const policyVersionId = rule?.policy_version_id ?? "";
  if (!rule || (!rule.router_enabled && !req.allowDisabledPolicy)) {
    return envelope<T>(base, policyVersionId, "unavailable", "miss", null, [], [], "disabled_by_policy");
  }

  // 3-4. candidate chain: registry order → policy mode → drop runtime-disabled
  const chain = applyMode(adaptersForIntent(intent, market), rule)
    .filter((a) => runtime.get(a.providerId)?.enabled !== false);

  if (rule.mode === "off") {
    return envelope<T>(base, policyVersionId, "unavailable", "miss", null, [], [], "disabled_by_policy");
  }
  if (chain.length === 0) {
    return envelope<T>(base, policyVersionId, "unavailable", "miss", null, [], [], "chain_exhausted");
  }

  const attempted: ProviderId[] = [];
  let staleFallback: { payload: T; provenance: FieldProvenance[]; provider: ProviderId } | null = null;

  // 5. fresh cache in provider order
  for (const adapter of chain) {
    const fp = evidenceFingerprint(intent, market, symbol, adapter.contractVersion);
    const { data: cached, error: cacheError } = await svc
      .from("evidence_cache_v2")
      .select("payload, provenance, expires_at, stale_until, quality_state")
      .eq("market", market).eq("symbol", symbol).eq("intent", intent)
      .eq("provider_id", adapter.providerId).eq("request_fingerprint", fp)
      .maybeSingle();
    if (cacheError) {
      return envelope<T>(base, policyVersionId, "unavailable", "miss", null, [], [], "provider_error");
    }
    if (cached?.payload != null) {
      const now = Date.now();
      const fresh = cached.expires_at && new Date(cached.expires_at).getTime() > now;
      if (fresh) {
        await ledger(svc, { provider: adapter.providerId, intent, market, symbol, run_id: req.runId,
          policy_version: policyVersionId, cache_outcome: "fresh", lease_outcome: "skipped",
          contract_version: adapter.contractVersion });
        return envelope<T>(base, policyVersionId, "fresh", "fresh", cached.payload as T, (cached.provenance ?? []) as FieldProvenance[], attempted);
      }
      const staleOk = cached.stale_until && new Date(cached.stale_until).getTime() > now;
      if (staleOk && !staleFallback) staleFallback = {
        payload: cached.payload as T,
        provenance: (cached.provenance ?? []) as FieldProvenance[],
        provider: adapter.providerId,
      };
    }
  }

  // Cohort evaluation is quota-neutral by contract. A cache miss is evidence of
  // missing readiness; it must never be repaired from inside the evaluator.
  if (req.cacheOnly) {
    if (staleFallback) {
      return envelope<T>(base, policyVersionId, "stale", "stale", staleFallback.payload, staleFallback.provenance, []);
    }
    return envelope<T>(base, policyVersionId, "unavailable", "miss", null, [], [], "chain_exhausted");
  }

  // 6. live fetch, at most MAX_SYNC_ATTEMPTS real calls
  let attempts = 0;
  let lastReason: UnavailableReason = "chain_exhausted";
  const maxAttempts = Math.min(MAX_SYNC_ATTEMPTS, Math.max(0, rule.max_sync_attempts));
  for (const adapter of chain) {
    if (attempts >= maxAttempts) break;
    if (adapter.cacheReadOnly) continue;
    const codeInterval = PROVIDER_SPECS[adapter.providerId]?.minIntervalMs ?? 0;
    const overrideInterval = runtime.get(adapter.providerId)?.min_interval_ms_override ?? 0;
    const minIntervalMs = Math.max(codeInterval, overrideInterval);
    if (adapter.pacingOwner !== "adapter" && minIntervalMs > 0) {
      const { data: acquired, error: leaseError } = await svc.rpc("try_acquire_provider_slot", {
        p_provider: adapter.providerId,
        p_min_interval_ms: minIntervalMs,
      });
      if (leaseError || acquired !== true) {
        lastReason = "rate_limited";
        attempted.push(adapter.providerId);
        await ledger(svc, {
          provider: adapter.providerId, intent, market, symbol, run_id: req.runId,
          policy_version: policyVersionId, cache_outcome: "miss", lease_outcome: "denied",
          error_code: "rate_limited", contract_version: adapter.contractVersion,
        });
        await enqueueRefresh(svc, market, symbol, intent, adapter.providerId);
        continue;
      }
    }
    attempts++;
    attempted.push(adapter.providerId);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let result;
    try {
      result = await adapter.fetch({ intent, symbol: req.symbol, market }, { market, asOf: req.asOf ?? new Date().toISOString(), runId: req.runId, timeoutMs });
    } catch {
      lastReason = "provider_error";
      await ledger(svc, { provider: adapter.providerId, intent, market, symbol, run_id: req.runId, policy_version: policyVersionId, cache_outcome: "miss", lease_outcome: "started", started_at: startedAt, error_code: "provider_error", contract_version: adapter.contractVersion });
      continue;
    }
    if (!result.ok) {
      lastReason = result.unavailableReason ?? "provider_error";
      await ledger(svc, { provider: adapter.providerId, intent, market, symbol, run_id: req.runId, policy_version: policyVersionId, cache_outcome: "miss", lease_outcome: "started", started_at: startedAt, completed_at: new Date().toISOString(), latency_ms: Date.now() - t0, error_code: lastReason, contract_version: adapter.contractVersion });
      continue;
    }
    // validate + canonicalize
    const validated = adapter.validate(result.payload);
    if (!validated.ok) {
      lastReason = validated.unavailableReason ?? "schema_invalid";
      await ledger(svc, { provider: adapter.providerId, intent, market, symbol, run_id: req.runId, policy_version: policyVersionId, cache_outcome: "miss", lease_outcome: "started", started_at: startedAt, completed_at: new Date().toISOString(), latency_ms: Date.now() - t0, error_code: lastReason, contract_version: adapter.contractVersion });
      continue;
    }
    const canonical = adapter.toCanonical(validated);
    const fp = evidenceFingerprint(intent, market, symbol, adapter.contractVersion);
    const now = Date.now();
    // 7. persist canonical cache (best-effort) BEFORE returning
    try {
      await svc.from("evidence_cache_v2").upsert({
        market, symbol, intent, provider_id: adapter.providerId, request_fingerprint: fp,
        schema_version: SCHEMA_VERSION, payload: canonical.payload as any,
        provenance: canonical.provenance as any, quality_state: "fresh",
        observed_at: canonical.provenance[0]?.observedAt ?? null,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(now + Math.min(spec.freshTtlSeconds, rule.max_age_seconds) * 1000).toISOString(),
        stale_until: new Date(now + Math.min(spec.staleCeilingSeconds, rule.stale_max_seconds) * 1000).toISOString(),
        currency: canonical.provenance[0]?.currency ?? null,
        basis: canonical.provenance[0]?.basis ?? null,
        payload_hash: createHash("sha1").update(JSON.stringify(canonical.payload)).digest("hex"),
      }, { onConflict: "market,symbol,intent,provider_id,request_fingerprint" });
    } catch { /* cache write is best-effort; the envelope still returns */ }
    await ledger(svc, { provider: adapter.providerId, intent, market, symbol, run_id: req.runId, policy_version: policyVersionId, cache_outcome: "miss", lease_outcome: "completed", started_at: startedAt, completed_at: new Date().toISOString(), latency_ms: Date.now() - t0, contract_version: adapter.contractVersion });
    return envelope<T>(base, policyVersionId, "fresh", "miss", canonical.payload as T, canonical.provenance, attempted);
  }

  // 9. no live success → policy-allowed stale, else typed unavailable
  if (staleFallback) {
    await enqueueRefresh(svc, market, symbol, intent, staleFallback.provider).catch(() => {});
    return envelope<T>(base, policyVersionId, "stale", "stale", staleFallback.payload, staleFallback.provenance, attempted);
  }
  return envelope<T>(base, policyVersionId, "unavailable", "miss", null, [], attempted, lastReason);
}

// Enqueue a durable refresh job (idempotent — the partial unique index on
// (market,symbol,intent,provider,fingerprint) WHERE status in queued/leased
// collapses duplicates). Never throws.
async function enqueueRefresh(svc: any, market: Market, symbol: string, intent: EvidenceIntent, provider: ProviderId): Promise<void> {
  const fp = evidenceFingerprint(intent, market, symbol, provider);
  try {
    await svc.from("provider_refresh_jobs").insert({
      market, symbol, intent, provider_id: provider, request_fingerprint: fp, status: "queued",
    });
  } catch { /* duplicate active job → unique-index violation is expected + fine */ }
}

export const evidenceRouter = { resolve: resolveEvidence };
