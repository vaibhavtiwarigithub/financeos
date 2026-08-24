import { fredSeriesDated, type FredObservation } from "@/lib/data/fred-macro";
import type { InstrumentPolicy } from "@/lib/scoring/instrument-taxonomy";

export const INSTRUMENT_FEATURE_VERSION = "instrument-family-features.v1";

type FeatureValue = {
  value: number | null;
  asOf: string | null;
  source: string;
  status: "ok" | "missing" | "stale" | "inapplicable";
};

export type InstrumentFamilyEvidence = {
  version: typeof INSTRUMENT_FEATURE_VERSION;
  lifecycle: "measure_only";
  family: InstrumentPolicy["family"];
  exposure_id: string;
  benchmark_symbol: string | null;
  features: Record<string, FeatureValue>;
  composite_score: null;
  actionability: "none";
  note: string;
};

type CloseRow = { symbol: string; date: string; close: number };
type SharedInputs = {
  realYield: FredObservation[];
  broadDollar: FredObservation[];
  closes: CloseRow[];
};

let shared: { day: string; promise: Promise<SharedInputs> } | null = null;

function today(): string { return new Date().toISOString().slice(0, 10); }

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ageDays(asOf: string | null): number | null {
  if (!asOf) return null;
  const at = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(at) ? Math.floor((Date.now() - at) / 86_400_000) : null;
}

function feature(value: number | null, asOf: string | null, source: string, maxAgeDays: number): FeatureValue {
  const age = ageDays(asOf);
  return {
    value,
    asOf,
    source,
    status: value == null || !asOf ? "missing" : age != null && age > maxAgeDays ? "stale" : "ok",
  };
}

function seriesChange(rows: readonly FredObservation[]): { value: number | null; asOf: string | null } {
  if (rows.length < 2) return { value: null, asOf: rows[0]?.date ?? null };
  const latest = rows[0];
  const oldest = rows[rows.length - 1];
  return { value: Number((latest.value - oldest.value).toFixed(4)), asOf: latest.date };
}

function returnPct(rows: readonly CloseRow[], symbol: string): { value: number | null; asOf: string | null } {
  const selected = rows.filter((row) => row.symbol === symbol).sort((a, b) => a.date.localeCompare(b.date));
  if (selected.length < 2) return { value: null, asOf: selected.at(-1)?.date ?? null };
  const first = finite(selected[0].close);
  const last = finite(selected.at(-1)?.close);
  return {
    value: first != null && last != null && first > 0 ? Number((((last / first) - 1) * 100).toFixed(4)) : null,
    asOf: selected.at(-1)?.date ?? null,
  };
}

async function loadShared(supabase: any): Promise<SharedInputs> {
  const day = today();
  if (shared?.day === day) return shared.promise;
  const promise = (async () => {
    const [realYield, broadDollar, cache] = await Promise.all([
      fredSeriesDated("DFII10", 21),
      fredSeriesDated("DTWEXBGS", 21),
      supabase.from("price_cache").select("symbol,date,close")
        .in("symbol", ["GLD", "SLV", "GDX"])
        // PostgREST's limit applies to the combined result, not per symbol.
        // Keep enough headroom that one symbol cannot starve another's 20-bar
        // history when cache density differs.
        .order("date", { ascending: false }).limit(300),
    ]);
    const closes = cache?.error ? [] : (cache?.data ?? []).map((row: any) => ({
      symbol: String(row.symbol ?? "").toUpperCase(), date: String(row.date ?? ""), close: Number(row.close),
    })).filter((row: CloseRow) => row.symbol && row.date && Number.isFinite(row.close));
    return { realYield, broadDollar, closes };
  })();
  shared = { day, promise };
  return promise;
}

export async function loadInstrumentFamilyEvidence(
  supabase: any,
  policy: InstrumentPolicy,
  technicalScore: number,
): Promise<InstrumentFamilyEvidence | null> {
  const relevant = new Set([
    "gold_bullion_fund", "silver_bullion_fund", "gold_miners_fund",
    "metal_producer_equity", "royalty_streaming_equity",
  ]);
  if (!relevant.has(policy.family)) return null;

  const inputs = await loadShared(supabase);
  const realYield = seriesChange(inputs.realYield);
  const dollar = seriesChange(inputs.broadDollar);
  const gold = returnPct(inputs.closes, "GLD");
  const silver = returnPct(inputs.closes, "SLV");
  const miners = returnPct(inputs.closes, "GDX");
  const relative = (left: { value: number | null; asOf: string | null }, right: { value: number | null; asOf: string | null }) => ({
    value: left.value != null && right.value != null ? Number((left.value - right.value).toFixed(4)) : null,
    asOf: left.asOf && right.asOf ? (left.asOf < right.asOf ? left.asOf : right.asOf) : null,
  });

  const features: Record<string, FeatureValue> = {
    technical_score_v1: feature(finite(technicalScore), today(), "decision_observation", 1),
    real_yield_10y_change_20obs_pp: feature(realYield.value, realYield.asOf, "FRED:DFII10", 7),
    broad_dollar_change_20obs_index_points: feature(dollar.value, dollar.asOf, "FRED:DTWEXBGS", 7),
    gold_return_20bars_pct: feature(gold.value, gold.asOf, "price_cache:GLD", 7),
  };
  if (policy.family === "silver_bullion_fund") {
    const rel = relative(silver, gold);
    features.silver_return_20bars_pct = feature(silver.value, silver.asOf, "price_cache:SLV", 7);
    features.silver_minus_gold_20bars_pct = feature(rel.value, rel.asOf, "price_cache:SLV-GLD", 7);
  }
  if (["gold_miners_fund", "metal_producer_equity", "royalty_streaming_equity"].includes(policy.family)) {
    const rel = relative(miners, gold);
    features.gold_miners_return_20bars_pct = feature(miners.value, miners.asOf, "price_cache:GDX", 7);
    features.gold_miners_minus_gold_20bars_pct = feature(rel.value, rel.asOf, "price_cache:GDX-GLD", 7);
  }

  return {
    version: INSTRUMENT_FEATURE_VERSION,
    lifecycle: "measure_only",
    family: policy.family,
    exposure_id: policy.exposureId,
    benchmark_symbol: policy.benchmarkSymbol,
    features,
    composite_score: null,
    actionability: "none",
    note: "Family evidence is recorded for forward validation only; it contributes zero points to v1 and cannot authorize a trade.",
  };
}

export const _test = { seriesChange, returnPct, feature };
