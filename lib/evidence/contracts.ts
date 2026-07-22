// Canonical Evidence Router — shared contracts (data-source-policy feature, Phase 2).
//
// This is the SOLE provenance contract for routed evidence. Agents request an
// evidence INTENT (never a provider or MCP tool); the router owns provider
// selection, cache, pacing, validation, and provenance. These are pure types +
// code-constant catalogs — NO runtime logic, NO side effects — so both the
// router and the (future) external-research worker snapshot import ONE definition
// and never diverge into a parallel truth layer.
//
// Nothing here reads the DB, calls a provider, or touches the money path.

import type { ProviderId } from "@/lib/data/provider-fetch";

export type { ProviderId };
export type Market = "us" | "india";
export type Currency = "USD" | "INR";

// Canonical evidence intents. Code constants — a DB row can never name an intent
// absent from this union.
export type EvidenceIntent =
  | "price.quote"
  | "price.daily_bars"
  | "fundamentals.reported"
  | "fundamentals.valuation"
  | "analyst.consensus"
  | "sentiment.news"
  | "insider.transactions"
  | "events.earnings"
  | "events.corporate_actions"
  | "macro.regime_inputs";

export const EVIDENCE_INTENTS: readonly EvidenceIntent[] = [
  "price.quote",
  "price.daily_bars",
  "fundamentals.reported",
  "fundamentals.valuation",
  "analyst.consensus",
  "sentiment.news",
  "insider.transactions",
  "events.earnings",
  "events.corporate_actions",
  "macro.regime_inputs",
] as const;

export type PolicyMode = "auto" | "prefer" | "only" | "off";

// A dimension can be unavailable for structurally different reasons; the scorer's
// availability-mask + renormalization must distinguish "not_applicable" (never
// scored for this symbol) from "unavailable" (should exist, absent right now).
export type EvidenceQuality =
  | "fresh"
  | "stale"
  | "partial"
  | "conflict"
  | "quarantined"
  | "unavailable"
  | "not_applicable";

export type CacheState = "fresh" | "stale" | "miss";

// Why a resolve returned no usable payload. Drives the router's negative-cache
// policy: genuine_no_data / not_applicable may be long-cached; transient
// (rate_limited/timeout/provider_error) must be short-cached only. (Two distinct
// no-data modes observed live: an empty-ok payload vs a provider error — see
// features/data-source-policy/PROBE_RESULTS.md.)
export type UnavailableReason =
  | "auth_missing"
  | "entitlement_missing"
  | "contract_invalid"
  | "rate_limited"
  | "daily_budget"
  | "timeout"
  | "provider_error"
  | "schema_invalid"
  | "genuine_no_data"
  | "chain_exhausted"
  | "disabled_by_policy"
  | "not_applicable";

export type MetricBasis =
  | "ttm"
  | "forward"
  | "annual"
  | "quarterly"
  | "spot"
  | "eod";

export type FieldUnit =
  | "fraction"
  | "currency"
  | "per_share"
  | "count"
  | "ratio"
  | "text";

// Per-field provenance. Every scored field records where it came from and its
// exact semantic basis, so a provider switch can NEVER silently swap (e.g.)
// forward P/E for TTM P/E under the same canonical field.
export interface FieldProvenance {
  providerId: ProviderId;
  providerField: string;
  basis: MetricBasis;
  periodEnd?: string;   // ISO date — the fiscal period the value describes
  observedAt?: string;  // when the fact became true / was published
  retrievedAt: string;  // when Kairos fetched it
  currency?: Currency;
  unit: FieldUnit;
}

export interface CanonicalField<T> {
  value: T;
  provenance: FieldProvenance;
}

// The single envelope every routed resolve returns. `payload` is the canonical,
// schema-validated result for the intent (or null when unavailable).
export interface EvidenceEnvelope<T = unknown> {
  schemaVersion: "evidence-v1";
  market: Market;
  symbol?: string;              // omitted for market-wide intents (macro)
  intent: EvidenceIntent;
  quality: EvidenceQuality;
  payload: T | null;
  provenance: FieldProvenance[];
  providersAttempted: ProviderId[];
  policyVersionId: string;
  cacheState: CacheState;
  unavailableReason?: UnavailableReason;
  resolvedAt: string;
}

// ── Intent catalog — code constants (default TTLs, applicable markets) ────────
// TTL values are policy DEFAULTS, not proof the observation is current;
// observedAt / periodEnd on each field remain authoritative.
export interface IntentSpec {
  intent: EvidenceIntent;
  markets: readonly Market[];
  freshTtlSeconds: number;       // serve without a live call within this age
  staleCeilingSeconds: number;   // policy-allowed stale ceiling (0 = no stale)
  scoreAffecting: boolean;       // feeds a deterministic scoring dimension
}

const DAY = 86_400;

export const INTENT_CATALOG: Record<EvidenceIntent, IntentSpec> = {
  "price.quote":                { intent: "price.quote",                markets: ["us", "india"], freshTtlSeconds: 120,       staleCeilingSeconds: DAY,       scoreAffecting: false },
  "price.daily_bars":           { intent: "price.daily_bars",           markets: ["us", "india"], freshTtlSeconds: DAY,       staleCeilingSeconds: 3 * DAY,   scoreAffecting: true },
  "fundamentals.reported":      { intent: "fundamentals.reported",      markets: ["us", "india"], freshTtlSeconds: 14 * DAY,  staleCeilingSeconds: 45 * DAY,  scoreAffecting: true },
  "fundamentals.valuation":     { intent: "fundamentals.valuation",     markets: ["us", "india"], freshTtlSeconds: 3 * DAY,   staleCeilingSeconds: 14 * DAY,  scoreAffecting: true },
  "analyst.consensus":          { intent: "analyst.consensus",          markets: ["us"],          freshTtlSeconds: 3 * DAY,   staleCeilingSeconds: 14 * DAY,  scoreAffecting: false },
  "sentiment.news":             { intent: "sentiment.news",             markets: ["us", "india"], freshTtlSeconds: DAY,       staleCeilingSeconds: 3 * DAY,   scoreAffecting: true },
  "insider.transactions":       { intent: "insider.transactions",       markets: ["us", "india"], freshTtlSeconds: DAY,       staleCeilingSeconds: 7 * DAY,   scoreAffecting: true },
  "events.earnings":            { intent: "events.earnings",            markets: ["us", "india"], freshTtlSeconds: DAY,       staleCeilingSeconds: 0,         scoreAffecting: false },
  "events.corporate_actions":   { intent: "events.corporate_actions",   markets: ["us", "india"], freshTtlSeconds: DAY,       staleCeilingSeconds: 0,         scoreAffecting: false },
  // MacroSentinel is backed by US-only FRED series; macro_regime table has no
  // market column. India never produces or stores macro regime data, so this
  // intent is US-only. The research pipeline (fetchMacroScore, applicableDimensions,
  // persistObservedResearchEvidence) all enforce this — the contract must match.
  "macro.regime_inputs":        { intent: "macro.regime_inputs",        markets: ["us"],          freshTtlSeconds: 7 * DAY,   staleCeilingSeconds: 10 * DAY,  scoreAffecting: true },
};

// ── Provider spec — code-owned capability/limit registry ──────────────────────
// DB overrides (provider_runtime_config) can only make these MORE conservative;
// they can never raise a limit above the code ceiling or add a capability.
export interface ProviderSpec {
  id: ProviderId;
  label: string;
  transport: "http" | "mcp" | "internal";
  markets: readonly Market[];
  capabilities: readonly EvidenceIntent[];
  dailyLimitState: "known" | "none" | "unknown";
  dailyLimit?: number;
  rateLimitState: "known" | "none" | "unknown";
  rateLimitCalls?: number;
  rateLimitWindowSeconds?: number;
  minIntervalMs: number;
  reserveCalls: number;
  entitlementRequired: boolean;
  credentialRef?: string;
  trustTier: 1 | 2 | 3 | 4 | 5;
  official: boolean;
}

// Context handed to an adapter for a single resolve. Carries NO secrets beyond
// what the adapter itself needs (a credentialRef the adapter resolves server-side)
// and the market/asOf ceiling for point-in-time fidelity.
export interface ProviderCallContext {
  market: Market;
  asOf: string;
  runId?: string;
  timeoutMs: number;
}

export interface ProviderRequest {
  intent: EvidenceIntent;
  symbol?: string;
  market: Market;
}

export interface ProviderResult<T = unknown> {
  ok: boolean;
  payload?: T;
  unavailableReason?: UnavailableReason;
  raw?: unknown; // retained only for the call ledger; never rendered to an LLM
}

// Every provider adapter implements this. `validate` canonicalizes + rejects bad
// payloads; `toCanonical` maps a validated result into the intent's canonical
// payload with field-level provenance. Deterministic — no LLM.
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  readonly intent: EvidenceIntent;
  readonly contractVersion: string;
  /** Cache bridge only: a miss must never consume a live-attempt slot. */
  readonly cacheReadOnly?: boolean;
  // Legacy-backed adapters may already acquire this provider's durable lease
  // inside providerCachedFetch. The router must not acquire it a second time.
  readonly pacingOwner?: "router" | "adapter";
  fetch(request: ProviderRequest, ctx: ProviderCallContext): Promise<ProviderResult>;
  validate(raw: unknown): ProviderResult;
  toCanonical(result: ProviderResult): { payload: unknown; provenance: FieldProvenance[] };
}

// Guard used by the router + APIs to reject a DB-supplied intent/market string
// that isn't a compiled constant.
export function isEvidenceIntent(x: unknown): x is EvidenceIntent {
  return typeof x === "string" && (EVIDENCE_INTENTS as readonly string[]).includes(x);
}
export function isMarket(x: unknown): x is Market {
  return x === "us" || x === "india";
}
