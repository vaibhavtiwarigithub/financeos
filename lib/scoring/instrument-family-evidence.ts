import { fredSeriesDated, type FredObservation } from "@/lib/data/fred-macro";
import type { InstrumentPolicy } from "@/lib/scoring/instrument-taxonomy";
import { reportIssue, resolveIssue } from "@/lib/system-health";

// v2 (2026-09-15): v1 labelled price returns "20bars" but measured first-to-last
// across every cached row returned for the symbol (~100 rows, ~4.5 months):
// production GLD recorded -7.17% when the real 20-bar return was -0.05%. v1 rows
// stay immutable in instrument_family_observations; evaluate v1 and v2 apart.
export const INSTRUMENT_FEATURE_VERSION = "instrument-family-features.v2";
export const OIL_EXPOSURE_VERSION = "oil-exposure-evidence.v1";

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

// Curated, reviewed membership only. Unknown symbols get no oil evidence — never a
// sector-name or ticker heuristic (features/exogenous-risk-evidence §6). No expected
// sign is encoded: the 2026-09-15 counterfactual did not support the textbook
// "OMCs suffer when crude rises" sign for BPCL/IOC (see FEATURE_ARCHITECTURE §11).
export type OilExposureClass =
  | "crude_oil_fund" | "energy_sector_fund" | "upstream_producer" | "integrated_major"
  | "refiner" | "oilfield_services" | "downstream_marketer" | "integrated_conglomerate";

const OIL_EXPOSURE: Record<"us" | "india", Record<string, OilExposureClass>> = {
  us: {
    USO: "crude_oil_fund", BNO: "crude_oil_fund",
    XLE: "energy_sector_fund", XOP: "energy_sector_fund",
    OXY: "upstream_producer", EOG: "upstream_producer", COP: "upstream_producer",
    DVN: "upstream_producer", FANG: "upstream_producer", APA: "upstream_producer",
    XOM: "integrated_major", CVX: "integrated_major",
    MPC: "refiner", PSX: "refiner", VLO: "refiner",
    SLB: "oilfield_services", HAL: "oilfield_services", BKR: "oilfield_services",
  },
  india: {
    "ONGC.NS": "upstream_producer", "OIL.NS": "upstream_producer",
    "BPCL.NS": "downstream_marketer", "IOC.NS": "downstream_marketer", "HINDPETRO.NS": "downstream_marketer",
    "RELIANCE.NS": "integrated_conglomerate",
  },
};

export type OilExposureEvidence = {
  version: typeof OIL_EXPOSURE_VERSION;
  lifecycle: "measure_only";
  market: "us" | "india";
  exposure_class: OilExposureClass;
  features: Record<string, FeatureValue>;
  actionability: "none";
  note: string;
};

type CloseRow = { symbol: string; date: string; close: number };
type SharedInputs = {
  realYield: FredObservation[];
  broadDollar: FredObservation[];
  wti: FredObservation[];
  brent: FredObservation[];
  closes: CloseRow[];
};

// Publication cadence differs per series, so one staleness bound does not fit.
// DFII10 is daily. DTWEXBGS is daily values released weekly (H.10). EIA spot
// crude on FRED lagged 6 days on 2026-09-15.
const FRED_MAX_AGE_DAYS = { DFII10: 7, DTWEXBGS: 10, DCOILWTICO: 10, DCOILBRENTEU: 10 } as const;

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

// Percent change from the observation `obs` steps back (rows are newest-first).
function seriesPct(rows: readonly FredObservation[], obs: number): { value: number | null; asOf: string | null } {
  const latest = rows[0];
  const base = rows[obs];
  if (!latest || !base || base.value <= 0) return { value: null, asOf: latest?.date ?? null };
  return { value: Number((((latest.value / base.value) - 1) * 100).toFixed(4)), asOf: latest.date };
}

// Return over exactly the last `bars` settled bars; less history is honest absence.
function returnPct(rows: readonly CloseRow[], symbol: string, bars = 20): { value: number | null; asOf: string | null } {
  const selected = rows.filter((row) => row.symbol === symbol).sort((a, b) => a.date.localeCompare(b.date)).slice(-(bars + 1));
  if (selected.length < bars + 1) return { value: null, asOf: selected.at(-1)?.date ?? null };
  const first = finite(selected[0].close);
  const last = finite(selected.at(-1)?.close);
  return {
    value: first != null && last != null && first > 0 ? Number((((last / first) - 1) * 100).toFixed(4)) : null,
    asOf: selected.at(-1)?.date ?? null,
  };
}

// A stale FRED input used to be visible only inside evidence rows — DFII10 sat on
// one value for nine days without anyone noticing. Raise it once per process-day.
async function flagFredFreshness(supabase: any, seriesId: keyof typeof FRED_MAX_AGE_DAYS, rows: readonly FredObservation[]) {
  const issueKey = `family-evidence-fred-stale:${seriesId}`;
  const asOf = rows[0]?.date ?? null;
  const age = ageDays(asOf);
  if (age != null && age <= FRED_MAX_AGE_DAYS[seriesId]) return resolveIssue(issueKey, supabase);
  const next = new Date(); next.setUTCHours(24, 0, 0, 0);
  return reportIssue({
    issueKey,
    severity: "warn",
    category: "data",
    title: `FRED ${seriesId} ${asOf ? `stale (latest ${asOf}, ${age}d old)` : "unavailable"}`,
    detail: `Measure-only gold/oil evidence records ${seriesId} as ${asOf ? "stale" : "missing"}. No score or trade reads it. ` +
      `Likely cause: the production FRED fetch failed and the provider cache carried an older payload forward. ` +
      `Check FRED_API_KEY on Vercel and the av_cache rows for FRED:${seriesId}.`,
    autoExpireAt: next.toISOString(),
  }, supabase);
}

async function loadShared(supabase: any): Promise<SharedInputs> {
  const day = today();
  if (shared?.day === day) return shared.promise;
  const promise = (async () => {
    const [realYield, broadDollar, wti, brent, cache] = await Promise.all([
      fredSeriesDated("DFII10", 21),
      fredSeriesDated("DTWEXBGS", 21),
      fredSeriesDated("DCOILWTICO", 25),
      fredSeriesDated("DCOILBRENTEU", 25),
      supabase.from("price_cache").select("symbol,date,close")
        .in("symbol", ["GLD", "SLV", "GDX", "USO"])
        // PostgREST's limit applies to the combined result, not per symbol.
        // 300 rows over 4 symbols leaves ~75 per symbol for a 21-row window.
        .order("date", { ascending: false }).limit(300),
    ]);
    await Promise.all([
      flagFredFreshness(supabase, "DFII10", realYield),
      flagFredFreshness(supabase, "DTWEXBGS", broadDollar),
      flagFredFreshness(supabase, "DCOILWTICO", wti),
      flagFredFreshness(supabase, "DCOILBRENTEU", brent),
    ]).catch(() => { /* health reporting never blocks evidence */ });
    const closes = cache?.error ? [] : (cache?.data ?? []).map((row: any) => ({
      symbol: String(row.symbol ?? "").toUpperCase(), date: String(row.date ?? ""), close: Number(row.close),
    })).filter((row: CloseRow) => row.symbol && row.date && Number.isFinite(row.close));
    return { realYield, broadDollar, wti, brent, closes };
  })();
  shared = { day, promise };
  return promise;
}

export function oilExposureClass(symbol: string, market: "us" | "india"): OilExposureClass | null {
  return OIL_EXPOSURE[market]?.[symbol.trim().toUpperCase()] ?? null;
}

export async function loadOilExposureEvidence(
  supabase: any,
  symbol: string,
  market: "us" | "india",
): Promise<OilExposureEvidence | null> {
  const exposureClass = oilExposureClass(symbol, market);
  if (!exposureClass) return null;
  const inputs = await loadShared(supabase);
  const wti20 = seriesPct(inputs.wti, 20);
  const brent20 = seriesPct(inputs.brent, 20);
  const brent5 = seriesPct(inputs.brent, 5);
  const uso20 = returnPct(inputs.closes, "USO", 20);
  const uso5 = returnPct(inputs.closes, "USO", 5);
  return {
    version: OIL_EXPOSURE_VERSION,
    lifecycle: "measure_only",
    market,
    exposure_class: exposureClass,
    features: {
      wti_change_20obs_pct: feature(wti20.value, wti20.asOf, "FRED:DCOILWTICO", FRED_MAX_AGE_DAYS.DCOILWTICO),
      brent_change_20obs_pct: feature(brent20.value, brent20.asOf, "FRED:DCOILBRENTEU", FRED_MAX_AGE_DAYS.DCOILBRENTEU),
      brent_change_5obs_pct: feature(brent5.value, brent5.asOf, "FRED:DCOILBRENTEU", FRED_MAX_AGE_DAYS.DCOILBRENTEU),
      // FRED spot crude lags about a week; settled USO is the same-week proxy.
      uso_return_20bars_pct: feature(uso20.value, uso20.asOf, "price_cache:USO", 7),
      uso_return_5bars_pct: feature(uso5.value, uso5.asOf, "price_cache:USO", 7),
    },
    actionability: "none",
    note: "Oil exposure evidence is recorded for forward validation only; it contributes zero points to v1 and cannot authorize a trade.",
  };
}

export async function loadInstrumentFamilyEvidence(
  supabase: any,
  policy: InstrumentPolicy,
  technicalScore: number,
): Promise<InstrumentFamilyEvidence | null> {
  const relevant = new Set([
    "gold_bullion_fund", "silver_bullion_fund", "gold_miners_fund",
    "metal_producer_equity", "royalty_streaming_equity", "crypto",
  ]);
  if (!relevant.has(policy.family)) return null;

  // Crypto: technical + macro features only. No metals-specific price ratios.
  // Stage 2 (2026-09-04) — see features/robinhood-crypto/FEATURE_ARCHITECTURE.md.
  if (policy.family === "crypto") {
    const inputs = await loadShared(supabase);
    const realYield = seriesChange(inputs.realYield);
    const dollar = seriesChange(inputs.broadDollar);
    return {
      version: INSTRUMENT_FEATURE_VERSION,
      lifecycle: "measure_only",
      family: "crypto",
      exposure_id: policy.exposureId,
      benchmark_symbol: null,
      features: {
        technical_score_v1: feature(finite(technicalScore), today(), "decision_observation", 1),
        real_yield_10y_change_20obs_pp: feature(realYield.value, realYield.asOf, "FRED:DFII10", FRED_MAX_AGE_DAYS.DFII10),
        broad_dollar_change_20obs_index_points: feature(dollar.value, dollar.asOf, "FRED:DTWEXBGS", FRED_MAX_AGE_DAYS.DTWEXBGS),
      },
      composite_score: null,
      actionability: "none",
      note: "Crypto family — measure_only. Technical + macro only; no fundamental/insider/analyst. No trade authorization.",
    };
  }

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
    real_yield_10y_change_20obs_pp: feature(realYield.value, realYield.asOf, "FRED:DFII10", FRED_MAX_AGE_DAYS.DFII10),
    broad_dollar_change_20obs_index_points: feature(dollar.value, dollar.asOf, "FRED:DTWEXBGS", FRED_MAX_AGE_DAYS.DTWEXBGS),
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

export const _test = { seriesChange, seriesPct, returnPct, feature };
