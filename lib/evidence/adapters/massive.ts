// Canonical Evidence Router — Massive provider adapters (data-source-policy, Phase 2).
//
// ADDITIVE ONLY. Nothing here is wired into scoring, the money path, or any
// registry; `router_enabled` stays false. These adapters exist so the router can
// later resolve Massive-backed intents through the ONE ProviderAdapter contract
// (lib/evidence/contracts.ts) instead of calling data helpers ad hoc.
//
// Deterministic, no LLM. Both adapters REUSE the existing Massive data helpers
// (scoreMassiveInsider / fetchMassiveCandles) — the HTTP, keying, cache, pacing,
// and budget accounting all stay in lib/data. This file only maps their output
// into canonical, provenance-tagged payloads and fails soft on every edge.

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
  ProviderCallContext,
  FieldProvenance,
} from "@/lib/evidence/contracts";
import { scoreMassiveInsider } from "@/lib/data/massive-insider";
import { fetchUsCandles } from "@/lib/data/candles";
import type { Candle } from "@/lib/data/technicals";
import type { ProviderId } from "@/lib/evidence/contracts";

const PROVIDER_ID = "massive" as const;

// Map a fetchUsCandles source string to a ProviderId for honest provenance.
function barsSourceProvider(source: string): ProviderId {
  return (["massive", "eodhd", "twelvedata"].includes(source) ? source : "massive") as ProviderId;
}

// ── shared guards ─────────────────────────────────────────────────────────────

// Reject prototype-pollution keys before we ever treat an object as a payload.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function hasForbiddenKeys(obj: object): boolean {
  return Object.keys(obj).some((k) => FORBIDDEN_KEYS.has(k));
}
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

// ── insider.transactions ──────────────────────────────────────────────────────

// Shape returned by scoreMassiveInsider — the raw we validate + canonicalize.
interface MassiveInsiderRaw {
  score: number;      // 0-100; 90 = 100% open-market buying, 10 = 100% selling
  summary: string;
  available: boolean;
}

// Canonical insider payload. netBuySell is a symmetric conviction ratio in
// [-1, 1] derived from the source's 10..90 buy-skew score; filingCount is the
// open-market trade count parsed from the human summary when present.
export interface CanonicalInsider {
  netBuySell: number;         // -1 (all selling) .. +1 (all buying)
  buyRatio: number;           // 0 .. 1
  score: number;              // source score, 0-100
  filingCount: number | null; // open-market P/S trades in the 90d window, if known
  summary: string;
}

function isMassiveInsiderRaw(x: unknown): x is MassiveInsiderRaw {
  if (!isPlainObject(x) || hasForbiddenKeys(x)) return false;
  return (
    isFiniteNumber(x.score) &&
    typeof x.summary === "string" &&
    typeof x.available === "boolean"
  );
}

// "3 open-market buys (...) vs 2 sells (...)" → 5. Best-effort; null when absent.
function parseFilingCount(summary: string): number | null {
  const buys = summary.match(/(\d+)\s+open-market buys/i);
  const sells = summary.match(/vs\s+(\d+)\s+sells/i);
  if (buys && sells) {
    const n = Number(buys[1]) + Number(sells[1]);
    return Number.isFinite(n) ? n : null;
  }
  const only = summary.match(/Only\s+(\d+)\s+open-market insider trade/i);
  if (only) {
    const n = Number(only[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const massiveInsiderAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  intent: "insider.transactions",
  contractVersion: "massive-insider-v1",

  // Massive Form 4 is US-only. A suffixed India symbol resolves to nothing
  // (unavailable) rather than wrong data, so we do not block India at the edge.
  async fetch(request: ProviderRequest, _ctx: ProviderCallContext): Promise<ProviderResult> {
    const symbol = (request.symbol ?? "").trim();
    if (!symbol) return { ok: false, unavailableReason: "genuine_no_data" };
    try {
      const res = await scoreMassiveInsider(symbol);
      if (!res || !res.available) {
        // Distinguish a missing credential from a genuine empty result so the
        // router's negative-cache policy can long-cache the latter only.
        const reason = /key missing/i.test(res?.summary ?? "")
          ? "auth_missing"
          : "genuine_no_data";
        return { ok: false, unavailableReason: reason };
      }
      return { ok: true, payload: res, raw: res };
    } catch {
      return { ok: false, unavailableReason: "provider_error" };
    }
  },

  validate(raw: unknown): ProviderResult {
    if (!isMassiveInsiderRaw(raw)) return { ok: false, unavailableReason: "schema_invalid" };
    if (raw.score < 0 || raw.score > 100) return { ok: false, unavailableReason: "schema_invalid" };
    return { ok: true, payload: raw, raw };
  },

  toCanonical(result: ProviderResult): { payload: unknown; provenance: FieldProvenance[] } {
    const raw = result.payload as MassiveInsiderRaw;
    // Invert scoreMassiveInsider's score = 10 + buyRatio*80.
    const buyRatio = Math.min(1, Math.max(0, (raw.score - 10) / 80));
    const netBuySell = Number((buyRatio * 2 - 1).toFixed(4));
    const filingCount = parseFilingCount(raw.summary);
    const retrievedAt = new Date().toISOString();

    const payload: CanonicalInsider = {
      netBuySell,
      buyRatio: Number(buyRatio.toFixed(4)),
      score: raw.score,
      filingCount,
      summary: raw.summary,
    };

    const provenance: FieldProvenance[] = [
      { providerId: PROVIDER_ID, providerField: "score→netBuySell", basis: "spot", unit: "ratio", retrievedAt },
      { providerId: PROVIDER_ID, providerField: "score→buyRatio",   basis: "spot", unit: "ratio", retrievedAt },
      { providerId: PROVIDER_ID, providerField: "score",            basis: "spot", unit: "ratio", retrievedAt },
    ];
    if (filingCount !== null) {
      provenance.push({ providerId: PROVIDER_ID, providerField: "summary→filingCount", basis: "spot", unit: "count", retrievedAt });
    }
    return { payload, provenance };
  },
};

// ── price.daily_bars ──────────────────────────────────────────────────────────

// Canonical daily-bar series. Massive aggregates are fetched adjusted=true, so
// `adjusted` is preserved as a first-class flag rather than silently assumed.
export interface CanonicalDailyBars {
  bars: Candle[];    // ascending by date; {date, open, high, low, close, volume}
  adjusted: boolean; // adjusted close (all US candle sources request adjusted)
  count: number;
  source: string;    // which provider actually served (massive|eodhd|twelvedata)
}

function isValidBar(x: unknown): x is Candle {
  if (!isPlainObject(x) || hasForbiddenKeys(x)) return false;
  return (
    typeof x.date === "string" &&
    isFiniteNumber(x.open) &&
    isFiniteNumber(x.high) &&
    isFiniteNumber(x.low) &&
    isFiniteNumber(x.close) &&
    isFiniteNumber(x.volume)
  );
}

// Uses the existing multi-source US candle resolver (Massive → EODHD →
// TwelveData) rather than Massive alone: Massive is 5/min-paced and starves at
// 50 symbols/run, whereas TwelveData (800/day) reliably backs the tail, lifting
// daily-bar coverage from ~30% to near-complete. Provenance records the source
// that actually served, not a nominal one.
export const massiveBarsAdapter: ProviderAdapter = {
  providerId: PROVIDER_ID,
  intent: "price.daily_bars",
  contractVersion: "us-bars-v2",

  async fetch(request: ProviderRequest, _ctx: ProviderCallContext): Promise<ProviderResult> {
    const symbol = (request.symbol ?? "").trim();
    if (!symbol) return { ok: false, unavailableReason: "genuine_no_data" };
    try {
      // No AV fallback here — AV is 25/day and reserve-only; the router relies on
      // Massive → EODHD → TwelveData, which is enough for daily bars.
      const { candles, source } = await fetchUsCandles(symbol, async () => []);
      if (!Array.isArray(candles) || candles.length === 0) {
        return { ok: false, unavailableReason: "genuine_no_data" };
      }
      return { ok: true, payload: { bars: candles, source }, raw: { source } };
    } catch {
      return { ok: false, unavailableReason: "provider_error" };
    }
  },

  validate(raw: unknown): ProviderResult {
    if (!isPlainObject(raw) || hasForbiddenKeys(raw)) return { ok: false, unavailableReason: "schema_invalid" };
    const bars = (raw as any).bars;
    if (!Array.isArray(bars) || bars.length === 0) return { ok: false, unavailableReason: "schema_invalid" };
    if (!bars.every(isValidBar)) return { ok: false, unavailableReason: "schema_invalid" };
    return { ok: true, payload: raw, raw };
  },

  toCanonical(result: ProviderResult): { payload: unknown; provenance: FieldProvenance[] } {
    const p = (result.payload as { bars: Candle[]; source: string }) ?? { bars: [], source: "massive" };
    const retrievedAt = new Date().toISOString();
    const provider = barsSourceProvider(p.source);
    const payload: CanonicalDailyBars = { bars: p.bars, adjusted: true, count: p.bars.length, source: p.source };
    const provenance: FieldProvenance[] = [
      { providerId: provider, providerField: "daily_bars", basis: "eod", unit: "currency", retrievedAt },
    ];
    return { payload, provenance };
  },
};
