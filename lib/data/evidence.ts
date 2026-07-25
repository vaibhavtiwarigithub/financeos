/**
 * Evidence Records — Phase 1
 * Every data fetch that influences a trade decision is recorded here.
 * Append-only. Source tier enforced.
 */

export type EvidenceType =
  | "ohlcv" | "quote" | "fundamental" | "analyst" | "insider"
  | "sentiment" | "macro" | "earnings" | "dividend" | "split" | "news";

export type SourceName =
  | "alpha_vantage" | "financial_datasets" | "robinhood"
  | "stocktwits" | "fred" | "price_cache" | "macro_sentinel" | "manual"
  | "finnhub" | "yahoo" | "fmp" | "massive" | "sec_edgar" | "gdelt"
  | "upstox" | "eodhd" | "twelvedata" | "social_composite" | "webull"
  | "unavailable";

export type QualityState = "ok" | "stale" | "conflict" | "missing" | "quarantined";

// Source tier definitions
export const SOURCE_TIERS: Record<SourceName, number> = {
  robinhood:          1,  // Broker — authoritative for fills, account state
  alpha_vantage:      2,  // Established structured data provider
  financial_datasets: 2,
  fred:               1,  // Government/Fed reserve data
  price_cache:        2,  // EOD from established provider
  macro_sentinel:     3,  // Derived/computed macro signal
  stocktwits:         5,  // Social media
  gdelt:              4,  // Open news aggregation
  social_composite:   4,  // Deterministic blend; payload names components
  finnhub:            2,
  yahoo:              3,  // Unofficial transport, validated fields
  fmp:                2,
  massive:            2,
  sec_edgar:          1,  // Official SEC filings
  upstox:             1,  // Broker/exchange transport
  eodhd:              2,
  twelvedata:         2,
  webull:             2,  // Cloud MCP read-only research (analyst/fundamentals/quotes)
  unavailable:        5,
  manual:             3,
};

export interface EvidenceRecord {
  symbol?: string;
  evidence_type: EvidenceType;
  source: SourceName;
  source_tier?: number;
  observed_at?: string;
  effective_at?: string;
  retrieved_at?: string;
  quality_state?: QualityState;
  payload?: unknown;
  payload_hash?: string;
  signal_id?: number;
  research_packet_id?: number;
  notes?: string;
}

/** Write a single evidence record. Fire-and-forget — never throws. */
export async function writeEvidence(
  supabase: any,
  record: EvidenceRecord
): Promise<void> {
  try {
    const tier = record.source_tier ?? SOURCE_TIERS[record.source] ?? 3;
    await supabase.from("evidence_records").insert({
      ...record,
      source_tier:  tier,
      retrieved_at: record.retrieved_at ?? new Date().toISOString(),
      quality_state: record.quality_state ?? "ok",
    });
  } catch {
    // Non-critical — never block trade flow for audit writes
  }
}

/** Write multiple evidence records in one insert. Fire-and-forget. */
export async function writeBatchEvidence(
  supabase: any,
  records: EvidenceRecord[]
): Promise<void> {
  if (records.length === 0) return;
  try {
    const rows = records.map(r => ({
      ...r,
      source_tier:  r.source_tier ?? SOURCE_TIERS[r.source] ?? 3,
      retrieved_at: r.retrieved_at ?? new Date().toISOString(),
      quality_state: r.quality_state ?? "ok",
    }));
    await supabase.from("evidence_records").insert(rows);
  } catch { /* non-critical */ }
}

/**
 * Write a single evidence record for trade-affecting data. THROWS on failure.
 * Use this (instead of writeEvidence) for any data that directly influences a signal,
 * fill price, or order decision. Failure blocks the calling operation (fail-closed).
 */
export async function writeEvidenceCritical(
  supabase: any,
  record: EvidenceRecord
): Promise<void> {
  const tier = record.source_tier ?? SOURCE_TIERS[record.source] ?? 3;
  const { error } = await supabase.from("evidence_records").insert({
    ...record,
    source_tier:  tier,
    retrieved_at: record.retrieved_at ?? new Date().toISOString(),
    quality_state: record.quality_state ?? "ok",
  });
  if (error) {
    throw new Error(`Evidence write failed (trade-critical): ${error.message}`);
  }
}
