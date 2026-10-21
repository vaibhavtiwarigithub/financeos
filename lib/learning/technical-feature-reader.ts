import { fetchAllRows } from "@/lib/supabase/paginate";
import { isEntryCandidateLong, isHoldingReview } from "@/lib/learning/entry-cohort";
import { signalProvenance } from "@/lib/learning/signal-provenance";
import { researchSessionCloseAt } from "@/lib/trading/market-calendar";
import { technicalFeatureDiagnostics, TECHNICAL_DIAGNOSTIC_VERSION, TECHNICAL_FEATURES, type FeaturePoint } from "./technical-feature-diagnostics";
import { FORMULA_VERSIONS } from "@/lib/scoring/formula-lineage";

export async function readTechnicalFeatureDiagnostics(svc: any, market: "us" | "india", horizon: number, symbol: string | null, cohort: "entry" | "holding") {
  const asOf = new Date().toISOString(), since = new Date(Date.now() - 90 * 86400000).toISOString();
  const rows: any[] = await fetchAllRows((from, to) => {
    let q = svc.from("observation_labels")
      .select("id,observation_id,benchmark_neutral_return,decision_observations!inner(id,ts,symbol,market,features,signal_id,entry_eligible,direction,decision_context,discovery_source)")
      .eq("horizon_days", horizon).eq("decision_observations.market", market)
      .gte("decision_observations.ts", since).lte("decision_observations.ts", asOf);
    if (symbol) q = q.eq("decision_observations.symbol", symbol);
    return q.order("id").range(from, to);
  }, "Technical feature labels");
  if (rows.length > 12000) throw new Error("Refusing an oversized partial analysis");
  const decision = (r: any) => Array.isArray(r.decision_observations) ? r.decision_observations[0] : r.decision_observations;
  const sources = await signalProvenance(svc, rows.map(decision).flatMap((o) => o?.signal_id ? [String(o.signal_id)] : []));
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: market === "us" ? "America/New_York" : "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const points: FeaturePoint[] = [];
  const lineageCounts: Record<string, number> = {};
  for (const row of rows) {
    const o = decision(row), source = o ? sources.get(String(o.signal_id)) : null;
    if (!o || source?.market !== market || !source.sessionValidated || row.benchmark_neutral_return == null || !Number.isFinite(Number(row.benchmark_neutral_return))) continue;
    const input = { entryEligible: o.entry_eligible, direction: o.direction, decisionContext: o.decision_context, discoverySource: o.discovery_source };
    if (cohort === "entry" ? !isEntryCandidateLong(input) : !isHoldingReview(input)) continue;
    if (!Number.isFinite(Date.parse(o.ts))) continue;
    const day = source.asOfSession;
    if (!day || day > formatter.format(new Date(o.ts)) || researchSessionCloseAt(market, day) == null) continue;
    const technical = o.features?.technical;
    if (!technical || typeof technical !== "object") continue;
    const formula = technical.formula_version ?? o.features?.formula_lineage?.versions?.technical ?? "legacy/unknown";
    const lineage = o.features?.formula_lineage;
    const lineageKey = lineage?.configurationHash ?? "legacy/unknown";
    lineageCounts[lineageKey] = (lineageCounts[lineageKey] ?? 0) + 1;
    points.push({ id: Number(o.id), symbol: String(o.symbol), day, ts: o.ts, formula: String(formula), technical, outcome: Number(row.benchmark_neutral_return) });
  }
  return {
    view: "features", market, horizon, symbol, cohort, asOf, since, readOnly: true,
    currentFormulaVersions: FORMULA_VERSIONS,
    planVersion: TECHNICAL_DIAGNOSTIC_VERSION, predeclaredFeatures: TECHNICAL_FEATURES.length,
    matchedPoints: points.length, excludedRows: rows.length - points.length,
    lineages: lineageCounts,
    cells: technicalFeatureDiagnostics(points, market, horizon, Boolean(symbol)),
    caveat: "Exploratory fixed-family diagnostics across researched instrument types, not leveraged intraday validation, strategy P&L or a parameter optimizer. Market IC uses >=5 symbols/date. A selected symbol uses non-overlapping time-series observations; its correlation t is withheld pending calibrated inference. Binary return contrasts are descriptive, unadjusted for selection or confounding. All variants/horizons/cohorts count toward multiplicity. Missing old formula/crossover provenance remains unknown. No automatic rule changes.",
  };
}
