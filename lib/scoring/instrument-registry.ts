import { isEtfSymbol } from "@/lib/asset-classification";
import { isLeveragedInverseEtf } from "@/lib/trading/symbol-policy";

export type InstrumentKind =
  | "us_equity"
  | "adr"
  | "etf"
  | "metal_fund"
  | "leveraged_or_inverse_etf"
  | "india_equity";

export type ClassificationSource =
  | "market_suffix"
  | "curated_adr"
  | "curated_static"
  | "inferred_equity";

export type InstrumentClassification = {
  market: "us" | "india";
  symbol: string;
  instrumentKind: InstrumentKind;
  source: ClassificationSource;
  confidence: "curated" | "derived" | "inferred";
};

const METAL_FUND_SYMBOLS = new Set(["GLD", "SLV", "GDX", "GDXJ", "IAU", "UGL", "GLL"]);

export function classifyInstrument(input: {
  symbol: string;
  market: "us" | "india";
  isAdr: boolean;
}): InstrumentClassification {
  const symbol = input.symbol.trim().toUpperCase();
  if (input.market === "india") {
    return { market: "india", symbol, instrumentKind: "india_equity", source: "market_suffix", confidence: "derived" };
  }
  if (isLeveragedInverseEtf(symbol)) {
    return { market: "us", symbol, instrumentKind: "leveraged_or_inverse_etf", source: "curated_static", confidence: "curated" };
  }
  if (METAL_FUND_SYMBOLS.has(symbol)) {
    return { market: "us", symbol, instrumentKind: "metal_fund", source: "curated_static", confidence: "curated" };
  }
  if (isEtfSymbol(symbol)) {
    return { market: "us", symbol, instrumentKind: "etf", source: "curated_static", confidence: "curated" };
  }
  if (input.isAdr) {
    return { market: "us", symbol, instrumentKind: "adr", source: "curated_adr", confidence: "curated" };
  }
  return { market: "us", symbol, instrumentKind: "us_equity", source: "inferred_equity", confidence: "inferred" };
}

/**
 * Observational only. `review_status='observe'` and `new_entry_allowed=false`
 * are persisted by the database; this write cannot grant trading authority.
 */
export async function persistInstrumentClassification(supabase: any, classification: InstrumentClassification): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("instrument_registry").upsert({
    market: classification.market,
    symbol: classification.symbol,
    instrument_kind: classification.instrumentKind,
    classification_source: classification.source,
    classification_confidence: classification.confidence,
    last_observed_at: now,
  }, { onConflict: "market,symbol" });
  if (error) throw new Error(`instrument registry upsert failed: ${error.message}`);
}
