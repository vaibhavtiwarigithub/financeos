import { createHash } from "node:crypto";
import { computeSpearmanIC } from "@/lib/validation/feature-check";

export const COUNCIL_HORIZONS = [2, 5, 10, 20] as const;
export const MIN_COUNSEL_CROSS_SECTION = 5;
export const MIN_COUNCIL_EFFECTIVE_WINDOWS = 12;

export type Forecast = {
  score: number;
  confidence: number;
  rationale: string;
  bull_case: string;
  bear_case: string;
  evidence_citations: Array<{ claim: string; source: string; as_of: string }>;
};

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (trimmed.startsWith("```") && !fenced) throw new Error("model_output_invalid_json");
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) throw new Error("model_output_not_json");

  let value: unknown;
  try { value = JSON.parse(candidate); }
  catch { throw new Error("model_output_invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model_output_invalid_shape");
  }
  return value;
}

const boundedText = (value: unknown, max = 1800): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export function parseForecast(text: string): Forecast {
  const value = extractJson(text) as Record<string, unknown>;
  const score = value.score;
  const confidence = value.confidence;
  if (typeof score !== "number") throw new Error("model_score_not_numeric");
  if (typeof confidence !== "number") throw new Error("model_confidence_not_numeric");
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("model_score_out_of_range");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("model_confidence_out_of_range");
  const citations = Array.isArray(value.evidence_citations) ? value.evidence_citations : [];
  const parsedCitations = citations.slice(0, 12).flatMap((item: any) => {
    if (!item || typeof item !== "object") return [];
    const claim = boundedText(item.claim, 300);
    const source = boundedText(item.source, 180);
    const as_of = boundedText(item.as_of, 80);
    return claim && source && as_of ? [{ claim, source, as_of }] : [];
  });
  if (parsedCitations.length === 0) throw new Error("model_citations_required");
  return {
    score,
    confidence,
    rationale: boundedText(value.rationale),
    bull_case: boundedText(value.bull_case, 1000),
    bear_case: boundedText(value.bear_case, 1000),
    evidence_citations: parsedCitations,
  };
}

function resolvePath(root: unknown, path: string): { value: unknown; ancestors: unknown[] } | null {
  const normalized = path.trim().replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1");
  const parts = normalized.split(".").filter(Boolean);
  if (!parts.length) return null;
  const ancestors: unknown[] = [root];
  let value: any = root;
  for (const part of parts) {
    if (value == null || (typeof value !== "object" && !Array.isArray(value))) return null;
    const key = Array.isArray(value) && /^\d+$/.test(part) ? Number(part) : part;
    if (!(key in value)) return null;
    value = value[key];
    ancestors.push(value);
  }
  return { value, ancestors };
}

function citationAsOf(path: string, ancestors: unknown[]): string | null {
  const timeKeys = ["available_at", "snapshot_at", "as_of", "asOf", "latest_as_of_date", "observed_at", "fetched_at", "retrieved_at", "updated_at", "timestamp", "date"];
  // The snapshot's root observed_at is a decision cutoff, not proof that every
  // nested feature was freshly fetched then. Only trust field/record metadata.
  for (let i = ancestors.length - 2; i > 0; i--) {
    const node = ancestors[i];
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const key of timeKeys) {
      const candidate = (node as Record<string, unknown>)[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  if (path === "price_at_decision" || path === "$.price_at_decision") {
    const root = ancestors[0] as any;
    return typeof root?.observed_at === "string" ? root.observed_at : null;
  }
  return null;
}

/** Reject citations to nonexistent fields or fabricated dates in the frozen snapshot. */
export function validateForecastCitations(forecast: Forecast, snapshot: unknown): Forecast {
  const citations = forecast.evidence_citations.map((citation) => {
    const resolved = resolvePath(snapshot, citation.source);
    if (!resolved) throw new Error("model_citation_path_missing");
    const expected = citationAsOf(citation.source, resolved.ancestors);
    if (expected == null) {
      if (citation.as_of.toLowerCase() !== "unknown") throw new Error("model_citation_asof_unavailable");
    } else {
      const supplied = citation.as_of;
      const matches = supplied === expected || supplied === expected.slice(0, 10) || expected === supplied.slice(0, 10);
      if (!matches) throw new Error("model_citation_asof_mismatch");
    }
    return citation;
  });
  return { ...forecast, evidence_citations: citations };
}

export function medianScore(scores: number[]): number | null {
  const valid = scores.filter((x) => Number.isFinite(x) && x >= 0 && x <= 100).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

export type CouncilLabelPoint = {
  market: "us" | "india";
  symbol: string;
  ts: string;
  score: number;
  benchmarkNeutralReturn: number;
};

export type CouncilIcCell = {
  market: "us" | "india";
  horizonDays: number;
  seriesKey: string;
  forecastModel: string | null;
  observationCount: number;
  qualifyingSessions: number;
  independentWindows: number;
  meanSessionRankIc: number | null;
  sdSessionRankIc: number | null;
  tStat: number | null;
  classification: "insufficient_evidence" | "measured_descriptive";
  reason: string;
};

/**
 * Per-session cross-sectional Spearman IC. The t-stat denominator uses
 * sessions/horizon, matching the existing dimension diagnostics overlap rule;
 * pooled observations are never treated as independent draws.
 */
export function buildCouncilIcCell(
  market: "us" | "india",
  horizonDays: number,
  seriesKey: string,
  forecastModel: string | null,
  points: CouncilLabelPoint[],
): CouncilIcCell {
  const byDate = new Map<string, CouncilLabelPoint[]>();
  for (const point of points) {
    if (point.market !== market || !Number.isFinite(point.score) || !Number.isFinite(point.benchmarkNeutralReturn)) continue;
    const date = point.ts.slice(0, 10);
    const rows = byDate.get(date) ?? [];
    rows.push(point);
    byDate.set(date, rows);
  }
  const sessionIcs: number[] = [];
  let observationCount = 0;
  for (const rows of byDate.values()) {
    const unique = new Map(rows.map((row) => [row.symbol, row]));
    const crossSection = [...unique.values()];
    if (crossSection.length < MIN_COUNSEL_CROSS_SECTION) continue;
    const ic = computeSpearmanIC(
      crossSection.map((row) => row.score),
      crossSection.map((row) => row.benchmarkNeutralReturn),
    );
    if (!ic) continue;
    observationCount += crossSection.length;
    sessionIcs.push(ic.ic);
  }
  const sessions = sessionIcs.length;
  const independentWindows = sessions / horizonDays;
  const mean = sessions ? sessionIcs.reduce((a, b) => a + b, 0) / sessions : null;
  const sd = sessions > 1 && mean != null
    ? Math.sqrt(sessionIcs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sessions - 1))
    : null;
  const enough = independentWindows >= MIN_COUNCIL_EFFECTIVE_WINDOWS && sessions >= 20;
  const tStat = enough && mean != null && sd != null && sd > 0
    ? mean / (sd / Math.sqrt(independentWindows))
    : null;
  return {
    market,
    horizonDays,
    seriesKey,
    forecastModel,
    observationCount,
    qualifyingSessions: sessions,
    independentWindows,
    meanSessionRankIc: mean,
    sdSessionRankIc: sd,
    tStat,
    classification: enough ? "measured_descriptive" : "insufficient_evidence",
    reason: enough
      ? "Descriptive per-session Spearman IC; t-stat uses horizon-overlap-adjusted effective windows. Not causal evidence."
      : `${sessions} qualifying sessions yield ${independentWindows.toFixed(2)} independent windows; need at least 20 sessions and 12 effective windows.`,
  };
}
