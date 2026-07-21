import { createHash } from "crypto";
import type { ComputedScores } from "@/lib/data/scores";
import type { SourceName } from "@/lib/data/evidence";
import type { Candle } from "@/lib/data/technicals";
import { INTENT_CATALOG, type EvidenceIntent, type FieldProvenance, type Market } from "@/lib/evidence/contracts";
import { OBSERVED_CONTRACTS } from "@/lib/evidence/adapters/kairos-observed";
import { evidenceFingerprint } from "@/lib/evidence/resolver";

const MARKET_SYMBOL = "__MARKET__";
const macroRuns = new Set<string>();

type CacheInput = {
  market: Market;
  symbol: string;
  runId?: string | null;
  isEtf: boolean;
  overview: Record<string, string>;
  candles: Candle[];
  scores: ComputedScores;
  sources: {
    fundamental: SourceName;
    technical: SourceName;
    sentiment: SourceName;
    insider: SourceName;
  };
};

function finite(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function fundamentalPayload(input: CacheInput): Record<string, unknown> {
  const ov = input.overview;
  return {
    netMargin: finite(ov.ProfitMargin),
    roe: finite(ov.ReturnOnEquityTTM),
    revenueGrowth: finite(ov.QuarterlyRevenueGrowthYOY),
    peRatio: finite(ov.PERatio),
    eps: finite(ov.EPS),
    sector: ov.Sector || undefined,
    industry: ov.Industry || undefined,
    dimensionScore: input.scores.fundamental_score,
    scoreInput: input.scores.evidence.fundamental,
    observedSource: input.sources.fundamental,
  };
}

function provenance(source: string, field: string, basis: FieldProvenance["basis"], unit: FieldProvenance["unit"], observedAt?: string): FieldProvenance {
  return {
    providerId: "kairos",
    providerField: `research_observed:${source}:${field}`,
    basis,
    unit,
    retrievedAt: new Date().toISOString(),
    observedAt,
  };
}

export async function persistObservedResearchEvidence(supabase: any, input: CacheInput): Promise<void> {
  const now = Date.now();
  const currency = input.market === "india" ? "INR" : "USD";
  const rows: Record<string, unknown>[] = [];

  const add = (
    intent: EvidenceIntent,
    symbol: string,
    contractVersion: string,
    payload: Record<string, unknown>,
    fieldProvenance: FieldProvenance[],
    observedAt?: string,
  ) => {
    const spec = INTENT_CATALOG[intent];
    rows.push({
      market: input.market,
      symbol,
      intent,
      provider_id: "kairos",
      request_fingerprint: evidenceFingerprint(intent, input.market, symbol, contractVersion),
      schema_version: "evidence-v1",
      payload,
      provenance: fieldProvenance,
      quality_state: "fresh",
      observed_at: observedAt ?? null,
      fetched_at: new Date(now).toISOString(),
      expires_at: new Date(now + spec.freshTtlSeconds * 1000).toISOString(),
      stale_until: new Date(now + spec.staleCeilingSeconds * 1000).toISOString(),
      currency,
      basis: fieldProvenance[0]?.basis ?? null,
      payload_hash: createHash("sha1").update(JSON.stringify(payload)).digest("hex"),
    });
  };

  if (!input.isEtf && input.scores.dataQuality.fundamentalDataAvailable) {
    const payload = fundamentalPayload(input);
    add("fundamentals.reported", input.symbol, OBSERVED_CONTRACTS.fundamentals, payload, [
      provenance(input.sources.fundamental, "reported_core", "ttm", "ratio"),
    ]);
  }

  if (input.candles.length >= 15) {
    const observedAt = input.candles[input.candles.length - 1]?.date;
    add("price.daily_bars", input.symbol, OBSERVED_CONTRACTS.bars, {
      bars: input.candles,
      adjusted: true,
      count: input.candles.length,
      source: input.sources.technical,
      dimensionScore: input.scores.technical_score,
      scoreInput: input.scores.evidence.technical,
      observedSource: input.sources.technical,
    }, [provenance(input.sources.technical, "daily_bars", "eod", "currency", observedAt)], observedAt);
  }

  if (input.scores.dataQuality.sentimentDataAvailable) {
    add("sentiment.news", input.symbol, OBSERVED_CONTRACTS.sentiment, {
      score: input.scores.sentiment_score,
      has_data: true,
      dimensionScore: input.scores.sentiment_score,
      scoreInput: input.scores.evidence.sentiment,
      observedSource: input.sources.sentiment,
    }, [provenance(input.sources.sentiment, "news_tone", "spot", "ratio")]);
  }

  if (input.scores.dataQuality.insiderDataAvailable) {
    add("insider.transactions", input.symbol, OBSERVED_CONTRACTS.insider, {
      score: input.scores.insider_score,
      netBuySell: Number(((input.scores.insider_score - 50) / 50).toFixed(4)),
      dimensionScore: input.scores.insider_score,
      scoreInput: input.scores.evidence.insider,
      observedSource: input.sources.insider,
    }, [provenance(input.sources.insider, "net_flow", "spot", "ratio")]);
  }

  const macroRun = `${input.runId ?? new Date(now).toISOString().slice(0, 10)}:${input.market}`;
  if (input.market === "us" && input.scores.dataQuality.macroDataAvailable && !macroRuns.has(macroRun)) {
    if (macroRuns.size >= 200) macroRuns.clear();
    macroRuns.add(macroRun);
    const macro = input.scores.evidence.macro;
    const observedAt = typeof macro.as_of === "string" ? macro.as_of : undefined;
    add("macro.regime_inputs", MARKET_SYMBOL, OBSERVED_CONTRACTS.macro, {
      regime: macro.regime,
      score: input.scores.macro_score,
      dimensionScore: input.scores.macro_score,
      scoreInput: macro,
      observedSource: "macro_sentinel",
    }, [provenance("macro_sentinel", "regime", "spot", "ratio", observedAt)], observedAt);
  }

  if (rows.length === 0) return;
  const { error } = await supabase.from("evidence_cache_v2").upsert(rows, {
    onConflict: "market,symbol,intent,provider_id,request_fingerprint",
  });
  if (error) throw new Error(`observed evidence cache write failed: ${error.message}`);
}
