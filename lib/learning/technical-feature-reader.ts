import { fetchAllRows } from "@/lib/supabase/paginate";
import { isEntryCandidateLong, isHoldingReview } from "@/lib/learning/entry-cohort";
import { signalProvenance } from "@/lib/learning/signal-provenance";
import { researchSessionCloseAt } from "@/lib/trading/market-calendar";
import { technicalFeatureDiagnostics, TECHNICAL_DIAGNOSTIC_VERSION, TECHNICAL_FEATURES, type FeaturePoint } from "./technical-feature-diagnostics";
import { FORMULA_VERSIONS } from "@/lib/scoring/formula-lineage";
import { councilComparisons as matchedScoreComparisons, predictionLookbackDays, type CouncilComparisonPoint } from "./council-comparison";
import { MIN_CROSS_SECTION as MIN_FORMULA_CROSS_SECTION } from "@/lib/score-variants/core";

export async function readTechnicalFeatureDiagnostics(svc: any, market: "us" | "india", horizon: number, symbol: string | null, cohort: "entry" | "holding") {
  const lookbackDays = predictionLookbackDays(horizon);
  const asOf = new Date().toISOString(), since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const rows: any[] = await fetchAllRows((from, to) => {
    if (from > 60000) throw new Error("Feature scope exceeds bounded read; refusing partial analysis");
    let q = svc.from("observation_labels")
      .select("id,observation_id,matured_at,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,technical:features->technical,formula_versions:features->formula_lineage->versions,configuration_hash:features->formula_lineage->>configurationHash,instrument_family:features->instrument->>family,technical_quality:features->quality->technical->>state,fundamental_quality:features->quality->fundamental->>state,sentiment_quality:features->quality->sentiment->>state,macro_quality:features->quality->macro->>state,insider_quality:features->quality->insider->>state,availability_mask,analyst_score,fundamental_score,technical_score,sentiment_score,macro_score,insider_score,signal_id,entry_eligible,direction,decision_context,discovery_source)")
      .eq("horizon_days", horizon).eq("decision_observations.market", market)
      .lte("matured_at", asOf)
      .gte("decision_observations.ts", since).lte("decision_observations.ts", asOf);
    if (symbol) q = q.eq("decision_observations.symbol", symbol);
    return q.order("id").range(from, to);
  }, "Technical feature labels");
  if (rows.length > 60000) throw new Error("Refusing an oversized partial analysis");
  const decision = (r: any) => Array.isArray(r.decision_observations) ? r.decision_observations[0] : r.decision_observations;
  const sources = await signalProvenance(svc, rows.map(decision).flatMap((o) => o?.signal_id ? [String(o.signal_id)] : []));
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: market === "us" ? "America/New_York" : "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const points: FeaturePoint[] = [];
  const dimensions = ["fundamental", "technical", "sentiment", "macro", "insider", "composite"] as const;
  const dimensionPoints = new Map(dimensions.map((dimension) => [dimension, [] as FeaturePoint[]]));
  const pairedMacdSlots = new Map<string, { ts: string; id: number; point: CouncilComparisonPoint | null }>();
  const score = (value: unknown): number | null => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  };
  const lineageCounts: Record<string, number> = {};
  for (const row of rows) {
    const o = decision(row), source = o ? sources.get(String(o.signal_id)) : null;
    if (!o || source?.market !== market || !source.sessionValidated || row.benchmark_neutral_return == null || !Number.isFinite(Number(row.benchmark_neutral_return))) continue;
    const input = { entryEligible: o.entry_eligible, direction: o.direction, decisionContext: o.decision_context, discoverySource: o.discovery_source };
    if (cohort === "entry" ? !isEntryCandidateLong(input) : !isHoldingReview(input)) continue;
    if (!Number.isFinite(Date.parse(o.ts))) continue;
    const day = source.asOfSession;
    if (!day || day > formatter.format(new Date(o.ts)) || researchSessionCloseAt(market, day) == null) continue;
    const storedTechnical = o.technical ?? o.features?.technical;
    const technical = storedTechnical && typeof storedTechnical === "object" ? storedTechnical : {};
    const versions = o.formula_versions ?? o.features?.formula_lineage?.versions;
    const formula = technical.formula_version ?? versions?.technical ?? "legacy/unknown";
    const lineage = o.features?.formula_lineage;
    const lineageKey = o.configuration_hash ?? lineage?.configurationHash ?? "legacy/unknown";
    lineageCounts[lineageKey] = (lineageCounts[lineageKey] ?? 0) + 1;
    // Frozen instrument identity only: today's taxonomy cannot relabel history.
    const storedFamily = o.instrument_family ?? o.features?.instrument?.family;
    const family = typeof storedFamily === "string" && storedFamily.trim() ? storedFamily : "legacy/unknown";
    const base = { id: Number(o.id), symbol: String(o.symbol), day, ts: o.ts, family, outcome: Number(row.benchmark_neutral_return) };
    const technicalUsable = o.availability_mask?.technical !== false && !["missing", "inapplicable", "not_enabled", "degraded"].includes(o.technical_quality ?? o.features?.quality?.technical?.state);
    points.push({ ...base, formula: String(formula), technical: technicalUsable ? technical : {} });
    const trace = technical.score_trace;
    const currentScore = score(o.technical_score), legacyScore = score(trace?.legacy_score);
    let pairedPoint: CouncilComparisonPoint | null = null;
    if (technicalUsable && o.availability_mask?.technical === true && currentScore != null && legacyScore != null
      && trace?.formula_version === formula && trace?.legacy_formula_version === "technical_dimension_v1"
      && score(trace?.score) === currentScore) {
      pairedPoint = { method: `${formula} vs frozen ${trace.legacy_formula_version} · family ${family}`,
        symbol: base.symbol, session: day, observationId: String(o.id), decisionTs: o.ts,
        score: currentScore, baseline: legacyScore, outcome: base.outcome };
    }
    const pairKey = JSON.stringify([formula, family, day, base.symbol]);
    const previous = pairedMacdSlots.get(pairKey);
    if (!previous || o.ts > previous.ts || (o.ts === previous.ts && base.id > previous.id)) pairedMacdSlots.set(pairKey, { ts: o.ts, id: base.id, point: pairedPoint });
    for (const dimension of dimensions) {
      const version = versions?.[dimension] ?? o.features?.[dimension]?.formula_version ?? "legacy/unknown";
      const state = o[`${dimension}_quality`] ?? o.features?.quality?.[dimension]?.state;
      const usable = dimension === "composite" || (o.availability_mask?.[dimension] === true && (state == null || state === "ok"));
      const value = usable ? score(o[dimension === "composite" ? "analyst_score" : `${dimension}_score`]) : null;
      dimensionPoints.get(dimension)!.push({ ...base, formula: String(version), technical: { score: value } });
    }
  }
  return {
    view: "features", market, horizon, symbol, cohort, asOf, since, lookbackDays, readOnly: true,
    currentFormulaVersions: FORMULA_VERSIONS,
    planVersion: TECHNICAL_DIAGNOSTIC_VERSION, predeclaredFeatures: TECHNICAL_FEATURES.length,
    matchedPoints: points.length, excludedRows: rows.length - points.length,
    lineages: lineageCounts,
    cells: technicalFeatureDiagnostics(points, market, horizon, Boolean(symbol)),
    dimensionCells: dimensions.flatMap((dimension) => technicalFeatureDiagnostics(dimensionPoints.get(dimension)!, market, horizon, Boolean(symbol), [{
      id: `${dimension}_score`, binary: false, value: (t) => score(t.score),
    }])),
    // One stock cannot have cross-sectional IC. The formula pair also retains
    // the existing, stricter 15-name formula floor, not the council's five.
    pairedMacd: symbol ? [] : matchedScoreComparisons([...pairedMacdSlots.values()].flatMap((slot) => slot.point ? [slot.point] : []), market, horizon, MIN_FORMULA_CROSS_SECTION),
    caveat: "Exploratory stored-score and fixed-feature diagnostics partitioned by frozen instrument family and formula, not leveraged intraday validation, strategy P&L or a parameter optimizer. Different rows can have different available samples: they are not a paired winner leaderboard. Missing dimension availability is excluded, never neutral-filled. Market IC uses >=5 symbols/date. A selected symbol uses non-overlapping time-series observations; its correlation t is withheld pending calibrated inference. Binary return contrasts are descriptive, unadjusted for selection or confounding. All variants/horizons/cohorts count toward multiplicity. Missing old formula/family/crossover provenance remains unknown. No automatic rule changes.",
  };
}
