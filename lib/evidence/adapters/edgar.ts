// Canonical Evidence Router — SEC EDGAR insider adapter (data-source-policy, Phase 2).
//
// ADDITIVE ONLY. router_enabled stays false; not wired into scoring/money path.
// Reuses the existing scoreEdgarInsider helper (lib/data/edgar-insider) — SEC
// Form 4, free, official, ~10 req/s (NO 5/min pace, unlike Massive). Registered
// AHEAD of Massive for insider.transactions so the fast/free source is tried
// first and Massive (paced) only backs the tail. Note: insider signal is sparse
// by nature — most symbols have <3 open-market P/S trades in 90d and correctly
// resolve `unavailable`; that is genuine absence, not a fetch failure.

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  ProviderCallContext,
  FieldProvenance,
} from "@/lib/evidence/contracts";
import { scoreEdgarInsider } from "@/lib/data/edgar-insider";

const PROVIDER_ID = "sec" as const;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

interface EdgarInsiderRaw { score: number; summary: string; available: boolean }

export interface CanonicalInsider {
  netBuySell: number;         // -1 (all selling) .. +1 (all buying)
  buyRatio: number;           // 0 .. 1
  score: number;              // source score, 0-100
  filingCount: number | null;
  summary: string;
}

function isEdgarInsiderRaw(x: unknown): x is EdgarInsiderRaw {
  if (!isPlainObject(x) || Object.keys(x).some((k) => FORBIDDEN_KEYS.has(k))) return false;
  return isFiniteNumber(x.score) && typeof x.summary === "string" && typeof x.available === "boolean";
}

// "SEC Form 4: 3 buys ($1.2M) vs 2 sells ($0.4M) in 90d." → 5. Best-effort.
function parseFilingCount(summary: string): number | null {
  const buys = summary.match(/(\d+)\s+buys/i);
  const sells = summary.match(/(\d+)\s+sells/i);
  if (buys && sells) {
    const n = Number(buys[1]) + Number(sells[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const edgarInsiderAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  intent: "insider.transactions",
  contractVersion: "edgar-insider-v1",

  async fetch(request: ProviderRequest, _ctx: ProviderCallContext): Promise<ProviderResult> {
    const symbol = (request.symbol ?? "").trim();
    if (!symbol) return { ok: false, unavailableReason: "genuine_no_data" };
    try {
      const res = await scoreEdgarInsider(symbol);
      // available:false covers "no CIK" (non-US) and "too few open-market trades"
      // — both are genuine no-data, safe to long-negative-cache.
      if (!res || !res.available) return { ok: false, unavailableReason: "genuine_no_data" };
      return { ok: true, payload: res, raw: res };
    } catch {
      return { ok: false, unavailableReason: "provider_error" };
    }
  },

  validate(raw: unknown): ProviderResult {
    if (!isEdgarInsiderRaw(raw)) return { ok: false, unavailableReason: "schema_invalid" };
    if (raw.score < 0 || raw.score > 100) return { ok: false, unavailableReason: "schema_invalid" };
    return { ok: true, payload: raw, raw };
  },

  toCanonical(result: ProviderResult): { payload: unknown; provenance: FieldProvenance[] } {
    const raw = result.payload as EdgarInsiderRaw;
    const buyRatio = Math.min(1, Math.max(0, (raw.score - 10) / 80)); // score = 10 + buyRatio*80
    const netBuySell = Number((buyRatio * 2 - 1).toFixed(4));
    const filingCount = parseFilingCount(raw.summary);
    const retrievedAt = new Date().toISOString();

    const payload: CanonicalInsider = {
      netBuySell, buyRatio: Number(buyRatio.toFixed(4)), score: raw.score, filingCount, summary: raw.summary,
    };
    const provenance: FieldProvenance[] = [
      { providerId: PROVIDER_ID, providerField: "form4→netBuySell", basis: "spot", unit: "ratio", retrievedAt },
      { providerId: PROVIDER_ID, providerField: "form4→buyRatio",   basis: "spot", unit: "ratio", retrievedAt },
      { providerId: PROVIDER_ID, providerField: "form4→score",      basis: "spot", unit: "ratio", retrievedAt },
    ];
    if (filingCount !== null) {
      provenance.push({ providerId: PROVIDER_ID, providerField: "summary→filingCount", basis: "spot", unit: "count", retrievedAt });
    }
    return { payload, provenance };
  },
};
