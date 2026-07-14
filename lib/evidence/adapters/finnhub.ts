// Canonical Evidence Router — Finnhub fundamentals adapter (additive, unwired).
//
// Implements the ProviderAdapter contract (lib/evidence/contracts.ts) for the
// intent "fundamentals.reported" on the US market. It is a THIN, deterministic
// wrapper over the already-validated lib/data/fundamentals.ts:fetchFinnhubOverview
// (Finnhub /stock/metric + /profile2 → AV-OVERVIEW shape). No HTTP is
// reimplemented here; no scoring / money-path code imports this yet
// (router_enabled stays false). Never throws out — every failure becomes a
// ProviderResult with ok:false and a typed UnavailableReason.
//
// IMPORTANT field-scale note: fetchFinnhubOverview ALREADY converts the
// percent-scaled Finnhub fields (ProfitMargin / ReturnOnEquityTTM /
// QuarterlyRevenueGrowthYOY) to fractions via its internal setFrac (÷100). So the
// Overview values this adapter consumes are ALREADY fractions — toCanonical does
// NOT divide again. PERatio and EPS are raw (ratio / per-share).

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  ProviderCallContext,
  FieldProvenance,
} from "@/lib/evidence/contracts";
import { fetchFinnhubOverview } from "@/lib/data/fundamentals";

// AV-OVERVIEW-shaped map (string values), as returned by fetchFinnhubOverview.
type Overview = Record<string, string>;

// Canonical payload for fundamentals.reported (Finnhub subset). All ratio/margin
// fields are fractions (0.27 = 27%); peRatio is a raw ratio; eps is per-share.
// Only fields Finnhub actually supplied are present.
interface FinnhubFundamentals {
  netMargin?: number;      // ProfitMargin (TTM), fraction
  roe?: number;            // ReturnOnEquityTTM, fraction
  revenueGrowth?: number;  // QuarterlyRevenueGrowthYOY, fraction
  peRatio?: number;        // PERatio (TTM), ratio
  eps?: number;            // EPS (TTM), per-share
  sector?: string;         // finnhubIndustry
}

const CONTRACT_VERSION = "finnhub-fundamentals-v1";
const PROVIDER_ID = "finnhub" as const;

// Prototype-pollution guard: reject payloads carrying dangerous own keys.
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function hasPollutionKey(obj: object): boolean {
  for (const k of Object.keys(obj)) {
    if (POLLUTION_KEYS.has(k)) return true;
  }
  return false;
}

// Parse an Overview string field to a finite number, or undefined.
function num(ov: Overview, key: string): number | undefined {
  const raw = ov[key];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export const finnhubFundamentalsAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  intent: "fundamentals.reported",
  contractVersion: CONTRACT_VERSION,

  // Delegate the actual network I/O to the shared, live-validated fetcher.
  // fetchFinnhubOverview never throws (returns {} on error / missing key), but we
  // still guard defensively so this adapter can NEVER propagate an exception.
  async fetch(
    request: ProviderRequest,
    _ctx: ProviderCallContext,
  ): Promise<ProviderResult> {
    const symbol = request.symbol;
    if (!symbol) {
      return { ok: false, unavailableReason: "genuine_no_data" };
    }
    try {
      const overview = await fetchFinnhubOverview(symbol);
      // fetchFinnhubOverview returns {} or a {Symbol}-only object when Finnhub had
      // nothing usable / the key is absent — treat as genuine no-data.
      const realFields = overview
        ? Object.keys(overview).filter((k) => k !== "Symbol").length
        : 0;
      if (!overview || realFields === 0) {
        return { ok: false, unavailableReason: "genuine_no_data" };
      }
      return { ok: true, payload: overview, raw: overview };
    } catch {
      return { ok: false, unavailableReason: "provider_error" };
    }
  },

  // Structural validation: must be a plain object with >=1 finite numeric
  // fundamental and no prototype-pollution keys.
  validate(raw: unknown): ProviderResult {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, unavailableReason: "schema_invalid" };
    }
    if (hasPollutionKey(raw as object)) {
      return { ok: false, unavailableReason: "schema_invalid" };
    }
    const ov = raw as Overview;
    const hasNumericFundamental =
      num(ov, "ProfitMargin") !== undefined ||
      num(ov, "ReturnOnEquityTTM") !== undefined ||
      num(ov, "QuarterlyRevenueGrowthYOY") !== undefined ||
      num(ov, "PERatio") !== undefined ||
      num(ov, "EPS") !== undefined;
    if (!hasNumericFundamental) {
      return { ok: false, unavailableReason: "schema_invalid" };
    }
    return { ok: true, payload: ov, raw };
  },

  // Map the AV-OVERVIEW subset into the canonical fundamentals object with
  // per-field provenance. Values are ALREADY fractions (see file header) — no
  // ÷100 here. retrievedAt is stamped now; Finnhub metrics are TTM basis.
  toCanonical(result: ProviderResult): {
    payload: FinnhubFundamentals;
    provenance: FieldProvenance[];
  } {
    const ov = (result.payload ?? {}) as Overview;
    const retrievedAt = new Date().toISOString();
    const payload: FinnhubFundamentals = {};
    const provenance: FieldProvenance[] = [];

    const mapNum = (
      canonicalField: keyof FinnhubFundamentals,
      providerField: string,
      unit: FieldProvenance["unit"],
      basis: FieldProvenance["basis"],
    ) => {
      const v = num(ov, providerField);
      if (v === undefined) return;
      (payload[canonicalField] as number) = v;
      provenance.push({
        providerId: PROVIDER_ID,
        providerField,
        basis,
        retrievedAt,
        unit,
      });
    };

    mapNum("netMargin", "ProfitMargin", "fraction", "ttm");
    mapNum("roe", "ReturnOnEquityTTM", "fraction", "ttm");
    mapNum("revenueGrowth", "QuarterlyRevenueGrowthYOY", "fraction", "quarterly");
    mapNum("peRatio", "PERatio", "ratio", "ttm");
    mapNum("eps", "EPS", "per_share", "ttm");

    const sector = ov.Sector;
    if (typeof sector === "string" && sector.length > 0) {
      payload.sector = sector;
      provenance.push({
        providerId: PROVIDER_ID,
        providerField: "Sector",
        basis: "spot",
        retrievedAt,
        unit: "text",
      });
    }

    return { payload, provenance };
  },
};
