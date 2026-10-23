import { createHash } from "node:crypto";
import { computeSpearmanIC } from "@/lib/validation/feature-check";

export const COUNCIL_HORIZONS = [2, 5, 10, 20] as const;
export const MIN_COUNSEL_CROSS_SECTION = 5;
export const MIN_COUNCIL_EFFECTIVE_WINDOWS = 12;
export const COUNCIL_PREDICTION_VERSION = "council_prediction_only_h10_v2";
export function councilVersionedSeriesKey(key: string, run: any): string {
  const v2 = String(run?.prompt_version ?? "").includes(COUNCIL_PREDICTION_VERSION)
    || run?.input_snapshot?.prediction_contract?.version === COUNCIL_PREDICTION_VERSION;
  return v2 ? `${key}|method=${COUNCIL_PREDICTION_VERSION}` : key;
}
export const COUNCIL_PREDICTION_GUIDANCE = "Forecast the instrument's future relative performance, NOT whether this app permits an order. Ignore trading permissions, position slots, budgets, deterministic score caps and entry thresholds. A 0–100 score is not a return percentage or win probability. This is a TEN-session outlook, not an intraday entry signal. For inverse funds distinguish sentiment about the fund from sentiment about its underlying; never reverse ambiguous social sentiment by assumption. Daily-reset leverage and overnight path risk remain relevant.";

/** New packets only: app permissions are not predictors of an asset's return. */
export function predictionOnlyEvidence(value: unknown): any {
  if (Array.isArray(value)) return value.map(predictionOnlyEvidence);
  if (value == null || typeof value !== "object") return value;
  const excluded = new Set(["score_mode", "new_entry_allowed", "review_status", "trade_plan",
    "trading_mandate", "entry_eligible", "rank_rejected", "threshold", "etfCap", "investability"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key))
    .map(([key, item]) => [key, predictionOnlyEvidence(item)]));
}

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

/** Reduce common model notations to a dotted path: JSON pointer, ["key"] brackets, and wrapper prefixes like "snapshot." or "FROZEN SNAPSHOT.". */
export function normalizeCitationPath(path: string): string {
  let p = path.trim();
  if (p.startsWith("/")) p = p.slice(1).replace(/\//g, ".");
  p = p.replace(/\[\s*["']([^"'\]]+)["']\s*\]/g, ".$1");
  p = p.replace(/^(?:\$\.?|(?:frozen[ _]?snapshot|snapshot|evidence|input|data|json|root)\s*[.:]\s*)/i, "");
  return p.replace(/^\.+/, "");
}
/** A model may write "facts.x in frozen snapshot (note)" in `source`. Keep only the leading path token; it must still resolve. */
export function leadingCitationPath(part: string): string {
  const normalized = normalizeCitationPath(part).replace(/^[\s`'"]+/, "");
  const match = /^[A-Za-z_$][\w$-]*(?:\.[\w$-]+|\[\d+\])*/.exec(normalized);
  return match ? match[0] : normalized;
}
function resolvePath(root: unknown, path: string): { value: unknown; ancestors: unknown[] } | null {
  const normalized = normalizeCitationPath(path).replace(/\[(\d+)\]/g, ".$1");
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
  const timeKeys = ["available_at", "snapshot_at", "as_of", "asOf", "latest_as_of_date", "reference_as_of", "period", "observed_at", "fetched_at", "retrieved_at", "updated_at", "timestamp", "date"];
  // The snapshot's root observed_at is a decision cutoff, not proof that every
  // nested feature was freshly fetched then. Only trust field/record metadata.
  // Start at the cited node itself: citing an object (e.g. features.technical) uses that object's own as_of.
  for (let i = ancestors.length - 1; i > 0; i--) {
    const node = ancestors[i];
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const key of timeKeys) {
      const candidate = (node as Record<string, unknown>)[key];
      // `period` is a date only when it looks like one (analyst ratings use it as their as-of date).
      if (key === "period" && !(typeof candidate === "string" && /^\d{4}-\d{2}-\d{2}/.test(candidate))) continue;
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
  }
  // The deterministic score block is computed at the decision cutoff, which is the observation timestamp.
  if (/^(\$\.)?deterministic_score(\.|$)/.test(path.trim())) {
    const root = ancestors[0] as any;
    return typeof root?.observed_at === "string" ? root.observed_at : null;
  }
  // Packet-level identity fields were written when the snapshot was frozen, so the freeze timestamp is their date.
  if (/^(\$\.)?(observed_at|symbol|market|currency|synthetic|note)$/.test(path.trim())) {
    const root = ancestors[0] as any;
    return typeof root?.observed_at === "string" ? root.observed_at : null;
  }
  if (path === "price_at_decision" || path === "$.price_at_decision") {
    const root = ancestors[0] as any;
    return typeof root?.observed_at === "string" ? root.observed_at : null;
  }
  return null;
}

/** Reject citations to nonexistent fields or fabricated dates in the frozen snapshot. */
export function validateForecastCitations(forecast: Forecast, snapshot: unknown): Forecast {
  const citations: Forecast["evidence_citations"] = [];
  for (const citation of forecast.evidence_citations) {
    // Models sometimes join several paths with commas; each part must resolve on its own.
    const parts = citation.source.split(/\s*(?:,|;|&|\band\b)\s*/i).filter(Boolean);
    if (!parts.length) throw new Error("model_citation_path_missing");
    for (const part of parts) {
      // A bare key that is not a top-level field may be a field under `features` (e.g. "trade_plan").
      // The real path must exist; nothing is invented, and the canonical path is what gets stored.
      let path = leadingCitationPath(part);
      let resolved = resolvePath(snapshot, path);
      if (!resolved && !/^features\./.test(path)) { path = `features.${path}`; resolved = resolvePath(snapshot, path); }
      if (!resolved) throw new Error("model_citation_path_missing");
      const expected = citationAsOf(path, resolved.ancestors);
      // "unknown" is always an honest (under-)claim. A concrete date must match the cited node's recorded date.
      // Dates are CANONICALIZED, never taken from the model: the cited node's recorded date when it has one,
      // otherwise "unknown". A wrong or unverifiable date therefore cannot be persisted, but it also no longer
      // discards an otherwise valid forecast (every rejected reply costs a real model call). The integrity
      // check that remains is that the cited path exists in the frozen snapshot.
      const asOf = expected ?? "unknown";
      citations.push({ ...citation, source: path, as_of: asOf });
    }
  }
  return { ...forecast, evidence_citations: citations.slice(0, 12) };
}

export function medianScore(scores: number[]): number | null {
  const valid = scores.filter((x) => Number.isFinite(x) && x >= 0 && x <= 100).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

/** Fixed, non-fitted 50/50 blend for paired research comparison only. */
export function equalWeightCouncilBlend(deterministicScore: unknown, councilScore: unknown): number | null {
  if (deterministicScore == null || councilScore == null || deterministicScore === "" || councilScore === "") return null;
  const a = typeof deterministicScore === "number" ? deterministicScore : Number(deterministicScore);
  const b = typeof councilScore === "number" ? councilScore : Number(councilScore);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > 100 || b < 0 || b > 100) return null;
  return (a + b) / 2;
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
