import type {
  EvidenceIntent,
  ProviderAdapter,
  ProviderResult,
} from "@/lib/evidence/contracts";

export const OBSERVED_CONTRACTS = {
  fundamentals: "kairos-observed-fundamentals-v1",
  bars: "kairos-observed-bars-v1",
  sentiment: "kairos-observed-sentiment-v1",
  macro: "kairos-observed-macro-v1",
  insider: "kairos-observed-insider-v1",
} as const;

function observedAdapter(intent: EvidenceIntent, contractVersion: string): ProviderAdapter {
  return {
    providerId: "kairos",
    intent,
    contractVersion,
    cacheReadOnly: true,
    pacingOwner: "adapter",
    async fetch(): Promise<ProviderResult> {
      return { ok: false, unavailableReason: "genuine_no_data" };
    },
    validate(raw: unknown): ProviderResult {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, unavailableReason: "schema_invalid" };
      }
      const score = Number((raw as any).dimensionScore);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        return { ok: false, unavailableReason: "schema_invalid" };
      }
      return { ok: true, payload: raw, raw };
    },
    toCanonical(result: ProviderResult) {
      return { payload: result.payload, provenance: [] };
    },
  };
}

export const observedFundamentalsAdapter = observedAdapter(
  "fundamentals.reported",
  OBSERVED_CONTRACTS.fundamentals,
);
export const observedBarsAdapter = observedAdapter("price.daily_bars", OBSERVED_CONTRACTS.bars);
export const observedSentimentAdapter = observedAdapter("sentiment.news", OBSERVED_CONTRACTS.sentiment);
export const observedMacroAdapter = observedAdapter("macro.regime_inputs", OBSERVED_CONTRACTS.macro);
export const observedInsiderAdapter = observedAdapter("insider.transactions", OBSERVED_CONTRACTS.insider);
