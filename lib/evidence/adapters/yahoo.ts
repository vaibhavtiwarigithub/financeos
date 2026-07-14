// Canonical Evidence Router — Yahoo Finance fundamentals adapter.
//
// ADDITIVE ONLY. This adapter is not wired into the router registry, the scorer,
// or the money path; `router_enabled` stays false. It exists so the router can be
// exercised in isolation once wiring lands. Deterministic — no LLM, no side
// effects beyond the reused Yahoo HTTP fetch.
//
// It implements the ProviderAdapter contract for the `fundamentals.reported`
// intent across the US and India markets. Rather than reimplementing Yahoo's
// crumb/cookie quoteSummary handshake, it REUSES `fetchIndiaOverview` from
// lib/india-data (misnamed for history; it already serves BOTH US and India per
// the fetchUsOverview chain in lib/data/fundamentals.ts). That function returns an
// Alpha-Vantage-OVERVIEW-shaped object (PERatio, ProfitMargin, ReturnOnEquityTTM,
// EPS, QuarterlyRevenueGrowthYOY, 52WeekHigh, AnalystTargetPrice, Sector,
// Industry, Symbol).
//
// MAPPING ASSUMPTION (documented, deliberate): the AV-OVERVIEW shape Yahoo emits
// here already stores margin / ROE / revenue-growth as DECIMAL FRACTIONS
// (profitMargins 0.27 = 27%, matching Alpha Vantage's own OVERVIEW convention and
// what scoreFundamentals reads). They are NOT percent strings, so they are mapped
// through unchanged — no divide-by-100 is applied, which would corrupt already-
// correct fractions. The canonical output is therefore fractions, as required.

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  ProviderCallContext,
  FieldProvenance,
  Currency,
  MetricBasis,
  FieldUnit,
} from "@/lib/evidence/contracts";
import { fetchIndiaOverview as fetchYahooOverview } from "@/lib/india-data";

type Overview = Record<string, string>;

const CONTRACT_VERSION = "yahoo-fundamentals-v1";

// Keys that must never be treated as data — a payload carrying any of these is a
// prototype-pollution attempt and is rejected outright by validate().
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// The numeric fundamentals we recognize. `field` is the canonical output key,
// `source` the AV-OVERVIEW key, plus the provenance basis/unit for each.
interface NumericFieldSpec {
  field: string;
  source: string;
  basis: MetricBasis;
  unit: FieldUnit;
  monetary: boolean; // stamp currency in provenance when true
}

const NUMERIC_FIELDS: readonly NumericFieldSpec[] = [
  { field: "netMargin",         source: "ProfitMargin",              basis: "ttm",       unit: "fraction",  monetary: false },
  { field: "roe",               source: "ReturnOnEquityTTM",         basis: "ttm",       unit: "fraction",  monetary: false },
  { field: "revenueGrowth",     source: "QuarterlyRevenueGrowthYOY", basis: "quarterly", unit: "fraction",  monetary: false },
  { field: "peRatio",           source: "PERatio",                   basis: "ttm",       unit: "ratio",     monetary: false },
  { field: "eps",               source: "EPS",                       basis: "ttm",       unit: "per_share", monetary: true  },
  { field: "fiftyTwoWeekHigh",  source: "52WeekHigh",                basis: "spot",      unit: "currency",  monetary: true  },
  { field: "analystTargetPrice", source: "AnalystTargetPrice",       basis: "forward",   unit: "currency",  monetary: true  },
] as const;

// Descriptive (text) fields carried through for provenance completeness.
const TEXT_FIELDS: readonly { field: string; source: string }[] = [
  { field: "sector",   source: "Sector" },
  { field: "industry", source: "Industry" },
] as const;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseFinite(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// India symbols on Yahoo carry an NSE (.NS) or BSE (.BO) suffix; everything else
// is treated as US → USD. toCanonical only receives a ProviderResult (no market),
// so currency is inferred from the payload's own Symbol — a deterministic, self-
// contained signal that matches the market the router requested.
function currencyForSymbol(symbol: string | undefined): Currency {
  if (!symbol) return "USD";
  const s = symbol.toUpperCase();
  return s.endsWith(".NS") || s.endsWith(".BO") ? "INR" : "USD";
}

// Count fundamentals actually present (excludes Symbol / bookkeeping keys).
function realFieldCount(ov: Overview): number {
  let n = 0;
  for (const spec of NUMERIC_FIELDS) if (parseFinite(ov[spec.source]) !== null) n++;
  for (const spec of TEXT_FIELDS) if (ov[spec.source]) n++;
  return n;
}

export const yahooFundamentalsAdapter: ProviderAdapter = {
  providerId: "yahoo",
  intent: "fundamentals.reported",
  contractVersion: CONTRACT_VERSION,

  async fetch(request: ProviderRequest, _ctx: ProviderCallContext): Promise<ProviderResult> {
    const symbol = request.symbol;
    if (!symbol) return { ok: false, unavailableReason: "genuine_no_data" };
    try {
      const overview = await fetchYahooOverview(symbol);
      // fetchYahooOverview returns {} (or a Symbol-only object) when Yahoo has no
      // usable fundamentals — treat that as a genuine empty, not an error.
      if (!isPlainObject(overview) || realFieldCount(overview as Overview) === 0) {
        return { ok: false, unavailableReason: "genuine_no_data" };
      }
      return { ok: true, payload: overview, raw: overview };
    } catch {
      return { ok: false, unavailableReason: "provider_error" };
    }
  },

  validate(raw: unknown): ProviderResult {
    if (!isPlainObject(raw)) return { ok: false, unavailableReason: "schema_invalid" };
    // Reject prototype-pollution payloads outright.
    for (const k of Object.keys(raw)) {
      if (FORBIDDEN_KEYS.has(k)) return { ok: false, unavailableReason: "schema_invalid" };
    }
    // Require at least one finite numeric fundamental.
    const hasNumeric = NUMERIC_FIELDS.some((spec) => parseFinite((raw as Overview)[spec.source]) !== null);
    if (!hasNumeric) return { ok: false, unavailableReason: "schema_invalid" };
    return { ok: true, payload: raw, raw };
  },

  toCanonical(result: ProviderResult): { payload: unknown; provenance: FieldProvenance[] } {
    const ov = (isPlainObject(result.payload) ? result.payload : {}) as Overview;
    const symbol = typeof ov.Symbol === "string" ? ov.Symbol : undefined;
    const currency = currencyForSymbol(symbol);
    const retrievedAt = new Date().toISOString();

    const payload: Record<string, number | string> = {};
    const provenance: FieldProvenance[] = [];

    for (const spec of NUMERIC_FIELDS) {
      const n = parseFinite(ov[spec.source]);
      if (n === null) continue;
      // Values arrive as fractions already (see MAPPING ASSUMPTION above); pass
      // through unchanged. Monetary/ratio fields are raw magnitudes.
      payload[spec.field] = n;
      provenance.push({
        providerId: "yahoo",
        providerField: spec.source,
        basis: spec.basis,
        retrievedAt,
        unit: spec.unit,
        ...(spec.monetary ? { currency } : {}),
      });
    }

    for (const spec of TEXT_FIELDS) {
      const v = ov[spec.source];
      if (!v) continue;
      payload[spec.field] = v;
      provenance.push({
        providerId: "yahoo",
        providerField: spec.source,
        basis: "spot",
        retrievedAt,
        unit: "text",
      });
    }

    return { payload, provenance };
  },
};
