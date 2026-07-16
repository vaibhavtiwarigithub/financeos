// Canonical Evidence Router — price.daily_bars adapters, ONE PER SOURCE.
//
// WHY THIS EXISTS (router-cutover §8, Codex pre-cutover finding):
// `price.daily_bars` used to be a single "massive" adapter that internally called
// fetchUsCandles(), which silently falls back Massive → EODHD → TwelveData. The
// adapter therefore advertised `providerId: "massive"` while EODHD or TwelveData
// might actually have served the bars. Three concrete harms:
//
//   1. PROVENANCE LIED. The envelope's `providersAttempted` and the call ledger
//      recorded a nominal source, not the serving one. §2.3's "source changes
//      must preserve field semantics" cannot be checked against a source you
//      cannot name — and the dual-run evaluation compares provenance per field.
//   2. POLICY WAS UNENFORCEABLE. `mode: "only"` on massive still silently served
//      TwelveData, because the fallback lived BELOW the router's policy layer.
//      An operator disabling a provider did not actually disable it.
//   3. PACING/BUDGET WAS INVISIBLE. Three providers' calls were accounted as one.
//
// Splitting makes the chain explicit: the ROUTER owns the fallback (registry
// order + policy mode), each adapter owns exactly one source, and provenance
// names the source that truly served. Each source keeps its own contractVersion,
// so a bad contract quarantines one provider instead of all three.
//
// No behavior change today: the router stays disabled (router_enabled=false) and
// the legacy path still calls fetchUsCandles() directly — untouched.

import type {
  FieldProvenance,
  ProviderAdapter,
  ProviderCallContext,
  ProviderId,
  ProviderRequest,
  ProviderResult,
} from "@/lib/evidence/contracts";
import type { Candle } from "@/lib/data/technicals";
import { hasForbiddenKeys, isFiniteNumber, isPlainObject } from "@/lib/evidence/adapters/shared";

// Canonical daily-bar series. All US candle sources are requested ADJUSTED, so
// `adjusted` is a first-class flag rather than a silent assumption — an
// adjusted/unadjusted swap is a hard parity failure, never a tolerance.
export interface CanonicalDailyBars {
  bars: Candle[];    // ascending by date; {date, open, high, low, close, volume}
  adjusted: boolean;
  count: number;
  /** The provider that ACTUALLY served these bars. Never nominal. */
  source: ProviderId;
}

// Minimum bars for a real RSI(14)/EMA20 — below this the series is not evidence
// (mirrors lib/data/candles.ts's minCandles and the scorer's >=15 gate).
export const MIN_BARS = 15;

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

/**
 * Build a single-source daily-bars adapter.
 *
 * `fetchCandles` MUST hit exactly one provider and MUST NOT fall back — that is
 * the entire point of the split. The router does the falling back.
 */
export function makeBarsAdapter(opts: {
  providerId: ProviderId;
  contractVersion: string;
  fetchCandles: (symbol: string) => Promise<Candle[]>;
  /** "adapter" when the underlying helper already takes the provider's lease. */
  pacingOwner?: "router" | "adapter";
}): ProviderAdapter {
  return {
    providerId: opts.providerId,
    intent: "price.daily_bars",
    contractVersion: opts.contractVersion,
    pacingOwner: opts.pacingOwner ?? "adapter",

    async fetch(request: ProviderRequest, _ctx: ProviderCallContext): Promise<ProviderResult> {
      const symbol = (request.symbol ?? "").trim();
      if (!symbol) return { ok: false, unavailableReason: "genuine_no_data" };
      try {
        const candles = await opts.fetchCandles(symbol);
        if (!Array.isArray(candles) || candles.length === 0) {
          // This source has nothing. The ROUTER decides whether to try the next
          // one — the adapter never reaches sideways for another provider.
          return { ok: false, unavailableReason: "genuine_no_data" };
        }
        if (candles.length < MIN_BARS) {
          // A sliver is not evidence: too few bars to compute a real indicator.
          // Reported as no-data rather than passed through, so nothing downstream
          // mistakes a 3-bar stub for a usable series.
          return { ok: false, unavailableReason: "genuine_no_data" };
        }
        return { ok: true, payload: { bars: candles, source: opts.providerId }, raw: { source: opts.providerId, count: candles.length } };
      } catch {
        return { ok: false, unavailableReason: "provider_error" };
      }
    },

    validate(raw: unknown): ProviderResult {
      if (!isPlainObject(raw) || hasForbiddenKeys(raw)) return { ok: false, unavailableReason: "schema_invalid" };
      const bars = (raw as any).bars;
      if (!Array.isArray(bars) || bars.length === 0) return { ok: false, unavailableReason: "schema_invalid" };
      if (!bars.every(isValidBar)) return { ok: false, unavailableReason: "schema_invalid" };
      if (bars.length < MIN_BARS) return { ok: false, unavailableReason: "genuine_no_data" };
      // The serving source must be the adapter's own provider. A payload
      // claiming another source is a contract violation, not a fallback.
      const source = (raw as any).source;
      if (source !== opts.providerId) return { ok: false, unavailableReason: "schema_invalid" };
      return { ok: true, payload: raw, raw };
    },

    toCanonical(result: ProviderResult): { payload: unknown; provenance: FieldProvenance[] } {
      const p = (result.payload as { bars: Candle[] }) ?? { bars: [] };
      const retrievedAt = new Date().toISOString();
      const payload: CanonicalDailyBars = {
        bars: p.bars,
        adjusted: true,
        count: p.bars.length,
        source: opts.providerId,
      };
      const provenance: FieldProvenance[] = [
        {
          // TRUE per-source provenance: this is the provider that served, by
          // construction — the adapter cannot have called anyone else.
          providerId: opts.providerId,
          providerField: "daily_bars",
          basis: "eod",
          unit: "currency",
          retrievedAt,
          observedAt: p.bars.length ? `${p.bars[p.bars.length - 1].date}T00:00:00.000Z` : undefined,
        },
      ];
      return { payload, provenance };
    },
  };
}
