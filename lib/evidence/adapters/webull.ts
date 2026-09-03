// Canonical Evidence Router — Webull adapters (data-source-policy feature).
//
// ADDITIVE ONLY. Nothing here is wired into scoring, the router registry, or the
// money path; `router_enabled` stays false and these adapters are dormant until a
// later change imports them. Webull is a FREE, READ-ONLY research data provider —
// `orderCapable` is false and NO order/trade tool is imported or referenced here.
//
// Deterministic, no LLM. Both adapters reuse the already-fixed live fetchers in
// `lib/data/webull-data.ts` (which own the MCP JSON-RPC calls, the required
// category:US_STOCK argument, and the verified payload parsing) and never
// reimplement an MCP call.
//
// Provenance basis is load-bearing and matches the VERIFIED live contract in
// features/data-source-policy/PROBE_RESULTS.md:
//   • Analyst: rating/targetPrice are "spot" consensus; forecastEps is "forward".
//   • Fundamentals: financial indicators are QUARTERLY (single newest quarter),
//     ratios already FRACTIONS (net_margin 0.266) — NEVER rescaled, NEVER labeled
//     annual/ttm. basis "quarterly" is the key correctness invariant.
// Two live no-data modes (empty-ok ETF like SPY → all null; error unknown symbol
// → null) both surface here as unavailableReason "genuine_no_data". A dead
// Webull session (OAuth expired / not connected) is checked FIRST and surfaces
// as "auth_missing" — never genuine_no_data — so a token outage can't poison
// the shadow-parity evidence or the router's negative signal.

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  ProviderCallContext,
  FieldProvenance,
  FieldUnit,
  MetricBasis,
  ProviderId,
} from "@/lib/evidence/contracts";
import {
  fetchWebullAnalyst,
  fetchWebullFinancials,
  webullSessionAvailable,
  type WebullAnalyst,
} from "@/lib/data/webull-data";

// "webull" is a first-class member of the shared ProviderId union
// (lib/data/provider-fetch.ts) — free MCP research provider, no order path.
const WEBULL_PROVIDER_ID: ProviderId = "webull";
const CURRENCY_USD = "USD" as const;

// ── shared guards (deterministic, no side effects) ───────────────────────────
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Reject prototype-pollution keys anywhere on the (shallow) payload — these
// adapters only ever emit flat records, so a shallow scan is sufficient.
function hasPollutionKey(obj: Record<string, unknown>): boolean {
  for (const k of Object.keys(obj)) {
    if (POLLUTION_KEYS.has(k)) return true;
  }
  return false;
}

// A present field must be either null (absent-but-allowed) or a finite number.
// A non-finite / non-null-non-number value fails validation (schema_invalid).
function finiteOrNull(v: unknown): boolean {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeProvenance(
  providerField: string,
  basis: MetricBasis,
  unit: FieldUnit,
  retrievedAt: string,
): FieldProvenance {
  return {
    providerId: WEBULL_PROVIDER_ID,
    providerField,
    basis,
    retrievedAt,
    currency: CURRENCY_USD,
    unit,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Analyst consensus adapter  (intent "analyst.consensus", US only)
// ═════════════════════════════════════════════════════════════════════════════

export interface WebullAnalystCanonical {
  rating: number | null;       // normalized 0-100 bullishness (spot consensus)
  targetPrice: number | null;  // consensus mean price target (spot)
  forecastEps: number | null;  // forward EPS estimate
}

const ANALYST_NUMERIC_KEYS: readonly (keyof WebullAnalystCanonical)[] = [
  "rating",
  "targetPrice",
  "forecastEps",
];

export const webullAnalystAdapter: ProviderAdapter = {
  providerId: WEBULL_PROVIDER_ID,
  intent: "analyst.consensus",
  contractVersion: "webull-analyst-v1",

  async fetch(
    request: ProviderRequest,
    _ctx: ProviderCallContext,
  ): Promise<ProviderResult> {
    const symbol = String(request.symbol ?? "").trim();
    if (!symbol) return { ok: false, unavailableReason: "genuine_no_data" };

    // An expired / missing Webull OAuth session makes the fetcher return null
    // for EVERY symbol, indistinguishable from a real empty result. Report that
    // as auth_missing so the router ledger + shadow-parity evidence don't record
    // a provider outage as "this symbol genuinely has no analyst consensus".
    if (!(await webullSessionAvailable())) {
      return { ok: false, unavailableReason: "auth_missing" };
    }

    const a: WebullAnalyst | null = await fetchWebullAnalyst(symbol);
    // null (not connected / no data) OR all three signal fields null → no data.
    // (Covers both live no-data modes: empty-ok ETF and error unknown symbol.)
    if (
      !a ||
      (a.rating == null && a.targetPrice == null && a.forecastEps == null)
    ) {
      return { ok: false, unavailableReason: "genuine_no_data" };
    }

    const payload: WebullAnalystCanonical = {
      rating: a.rating,
      targetPrice: a.targetPrice,
      forecastEps: a.forecastEps,
    };
    return { ok: true, payload, raw: a };
  },

  validate(raw: unknown): ProviderResult {
    if (!isPlainRecord(raw) || hasPollutionKey(raw)) {
      return { ok: false, unavailableReason: "schema_invalid" };
    }
    for (const k of ANALYST_NUMERIC_KEYS) {
      if (!(k in raw)) return { ok: false, unavailableReason: "schema_invalid" };
      if (!finiteOrNull(raw[k])) {
        return { ok: false, unavailableReason: "schema_invalid" };
      }
    }
    const payload: WebullAnalystCanonical = {
      rating: (raw.rating as number | null) ?? null,
      targetPrice: (raw.targetPrice as number | null) ?? null,
      forecastEps: (raw.forecastEps as number | null) ?? null,
    };
    return { ok: true, payload };
  },

  toCanonical(result: ProviderResult): {
    payload: WebullAnalystCanonical;
    provenance: FieldProvenance[];
  } {
    const src = (result.payload ?? {}) as Partial<WebullAnalystCanonical>;
    const retrievedAt = nowIso();
    const payload: WebullAnalystCanonical = {
      rating: src.rating ?? null,
      targetPrice: src.targetPrice ?? null,
      forecastEps: src.forecastEps ?? null,
    };
    // basis: rating/target are spot consensus; forecastEps is forward-looking.
    const provenance: FieldProvenance[] = [
      makeProvenance("rating", "spot", "count", retrievedAt),
      makeProvenance("targetPrice", "spot", "currency", retrievedAt),
      makeProvenance("forecastEps", "forward", "per_share", retrievedAt),
    ];
    return { payload, provenance };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// 2. Fundamentals (reported) adapter  (intent "fundamentals.reported", US only)
// ═════════════════════════════════════════════════════════════════════════════

export interface WebullFundamentalsCanonical {
  netMargin: number | null;
  roe: number | null;
  roa: number | null;
  debtToAssets: number | null;
  dilutedEpsInclExtra: number | null;
  naps: number | null;
  ocfPs: number | null;
  capSurplusPs: number | null;
}

// Raw Webull metric key → canonical field + its unit. basis is QUARTERLY for
// every field (single newest reported quarter — NOT annual, NOT ttm). Ratios are
// already fractions; the per-share metrics carry unit "per_share".
const FUNDAMENTAL_FIELDS: ReadonlyArray<{
  raw: string;
  canonical: keyof WebullFundamentalsCanonical;
  unit: FieldUnit;
}> = [
  { raw: "net_margin", canonical: "netMargin", unit: "fraction" },
  { raw: "roe", canonical: "roe", unit: "fraction" },
  { raw: "roa", canonical: "roa", unit: "fraction" },
  { raw: "debt_to_assets", canonical: "debtToAssets", unit: "fraction" },
  { raw: "diluted_eps_incl_extra", canonical: "dilutedEpsInclExtra", unit: "per_share" },
  { raw: "naps", canonical: "naps", unit: "per_share" },
  { raw: "ocf_ps", canonical: "ocfPs", unit: "per_share" },
  { raw: "cap_surplus_ps", canonical: "capSurplusPs", unit: "per_share" },
];

const FUNDAMENTALS_BASIS: MetricBasis = "quarterly";

function emptyFundamentals(): WebullFundamentalsCanonical {
  return {
    netMargin: null,
    roe: null,
    roa: null,
    debtToAssets: null,
    dilutedEpsInclExtra: null,
    naps: null,
    ocfPs: null,
    capSurplusPs: null,
  };
}

export const webullFundamentalsAdapter: ProviderAdapter = {
  providerId: WEBULL_PROVIDER_ID,
  intent: "fundamentals.reported",
  contractVersion: "webull-fundamentals-v1",

  async fetch(
    request: ProviderRequest,
    _ctx: ProviderCallContext,
  ): Promise<ProviderResult> {
    const symbol = String(request.symbol ?? "").trim();
    if (!symbol) return { ok: false, unavailableReason: "genuine_no_data" };

    // See the analyst adapter: a dead Webull session must surface as auth_missing,
    // not genuine_no_data, or every symbol looks like it has no reported fundamentals.
    if (!(await webullSessionAvailable())) {
      return { ok: false, unavailableReason: "auth_missing" };
    }

    const raw = await fetchWebullFinancials(symbol);
    // null (not connected / error symbol) OR empty record (empty-ok ETF) → no data.
    if (!raw || Object.keys(raw).length === 0) {
      return { ok: false, unavailableReason: "genuine_no_data" };
    }

    // Map only the known metrics; ratios are already fractions — DO NOT rescale.
    const payload = emptyFundamentals();
    let any = false;
    for (const { raw: rawKey, canonical } of FUNDAMENTAL_FIELDS) {
      const v = raw[rawKey];
      if (typeof v === "number" && Number.isFinite(v)) {
        payload[canonical] = v;
        any = true;
      }
    }
    if (!any) return { ok: false, unavailableReason: "genuine_no_data" };

    return { ok: true, payload, raw };
  },

  validate(raw: unknown): ProviderResult {
    if (!isPlainRecord(raw) || hasPollutionKey(raw)) {
      return { ok: false, unavailableReason: "schema_invalid" };
    }
    for (const { canonical } of FUNDAMENTAL_FIELDS) {
      if (!(canonical in raw)) {
        return { ok: false, unavailableReason: "schema_invalid" };
      }
      if (!finiteOrNull(raw[canonical])) {
        return { ok: false, unavailableReason: "schema_invalid" };
      }
    }
    const payload = emptyFundamentals();
    for (const { canonical } of FUNDAMENTAL_FIELDS) {
      payload[canonical] = (raw[canonical] as number | null) ?? null;
    }
    return { ok: true, payload };
  },

  toCanonical(result: ProviderResult): {
    payload: WebullFundamentalsCanonical;
    provenance: FieldProvenance[];
  } {
    const src = (result.payload ?? {}) as Partial<WebullFundamentalsCanonical>;
    const retrievedAt = nowIso();
    const payload = emptyFundamentals();
    const provenance: FieldProvenance[] = [];
    for (const { raw: rawKey, canonical, unit } of FUNDAMENTAL_FIELDS) {
      payload[canonical] = src[canonical] ?? null;
      // basis QUARTERLY — the single correctness point; never annual/ttm.
      provenance.push(makeProvenance(rawKey, FUNDAMENTALS_BASIS, unit, retrievedAt));
    }
    return { payload, provenance };
  },
};
