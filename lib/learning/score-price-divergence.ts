import crypto from "node:crypto";

export const SCORE_PRICE_DIVERGENCE_POLICY = "score-price-divergence-v1";
export const SCORE_PRICE_PRIMARY_WINDOW = 5;
export const SCORE_PRICE_MIN_SCORE_DELTA = 5;
export const SCORE_PRICE_MIN_PRICE_MOVE_PCT = 2;

const DIMENSION_KEYS = ["fundamental", "technical", "sentiment", "macro", "insider"] as const;

export type DivergenceInput = {
  id: number;
  ts: string;
  market: string;
  symbol: string;
  analyst_score: unknown;
  fundamental_score?: unknown;
  technical_score?: unknown;
  sentiment_score?: unknown;
  macro_score?: unknown;
  insider_score?: unknown;
  price_at_decision: unknown;
  features?: any;
  availability_mask?: any;
  weights_used?: any;
  score_source?: string | null;
  scoring_version?: string | null;
};

export type DivergencePoint = {
  id: number;
  ts: string;
  market: "us" | "india";
  symbol: string;
  session: string;
  score: number;
  price: number;
  scores: Record<(typeof DIMENSION_KEYS)[number], number | null>;
  scoreSource: string;
  scoringVersion: string;
  availabilityFingerprint: string;
  weightsFingerprint: string;
};

export type DivergenceEvent = {
  market: "us" | "india";
  symbol: string;
  windowSessions: 3 | 5;
  startObservationId: number;
  endObservationId: number;
  startSession: string;
  endSession: string;
  direction: "falling_score_rising_price" | "rising_score_falling_price";
  scoreDelta: number;
  priceReturnPct: number;
  dimensionDeltas: Record<string, number | null>;
  scoreSource: string;
  scoringVersion: string;
  availabilityFingerprint: string;
  weightsFingerprint: string;
  isPrimary: boolean;
};

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function normalizeDivergenceObservations(rows: DivergenceInput[], market: "us" | "india") {
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const canonical = new Map<string, DivergencePoint>();

  for (const row of rows) {
    if (row.market !== market) { exclude("wrong_market"); continue; }
    if (row.score_source !== "deterministic_v1") { exclude("non_deterministic_score"); continue; }
    if (!row.scoring_version) { exclude("missing_scoring_version"); continue; }
    if (row.availability_mask?.technical !== true) { exclude("technical_unavailable"); continue; }
    const score = finite(row.analyst_score);
    const price = finite(row.price_at_decision);
    if (score == null || price == null || price <= 0) { exclude("invalid_score_or_price"); continue; }
    const technicalSession = row.features?.technical?.as_of;
    const session = typeof technicalSession === "string" && /^\d{4}-\d{2}-\d{2}$/.test(technicalSession)
      ? technicalSession
      : null;
    if (!session) { exclude("missing_technical_session"); continue; }
    const point: DivergencePoint = {
      id: Number(row.id), ts: row.ts, market, symbol: row.symbol, session, score, price,
      scores: {
        fundamental: finite(row.fundamental_score), technical: finite(row.technical_score),
        sentiment: finite(row.sentiment_score), macro: finite(row.macro_score), insider: finite(row.insider_score),
      },
      scoreSource: row.score_source,
      scoringVersion: row.scoring_version,
      availabilityFingerprint: fingerprint(row.availability_mask ?? null),
      weightsFingerprint: fingerprint(row.weights_used ?? null),
    };
    const key = `${market}:${row.symbol}:${session}`;
    const previous = canonical.get(key);
    if (previous) exclude("duplicate_symbol_session");
    if (!previous || Date.parse(point.ts) > Date.parse(previous.ts) || (point.ts === previous.ts && point.id > previous.id)) {
      canonical.set(key, point);
    }
  }

  return {
    points: [...canonical.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.session.localeCompare(b.session) || a.id - b.id),
    exclusions,
  };
}

function stableMethodology(a: DivergencePoint, b: DivergencePoint): boolean {
  return a.scoreSource === b.scoreSource
    && a.scoringVersion === b.scoringVersion
    && a.availabilityFingerprint === b.availabilityFingerprint
    && a.weightsFingerprint === b.weightsFingerprint;
}

export function buildDivergenceEvents(points: DivergencePoint[]): DivergenceEvent[] {
  const grouped = new Map<string, DivergencePoint[]>();
  for (const point of points) {
    const symbolPoints = grouped.get(point.symbol) ?? [];
    symbolPoints.push(point);
    grouped.set(point.symbol, symbolPoints);
  }
  const events: DivergenceEvent[] = [];
  for (const rows of grouped.values()) {
    rows.sort((a, b) => a.session.localeCompare(b.session) || a.id - b.id);
    for (const windowSessions of [3, 5] as const) {
      for (let endIndex = windowSessions - 1; endIndex < rows.length; endIndex++) {
        const start = rows[endIndex - windowSessions + 1];
        const end = rows[endIndex];
        const window = rows.slice(endIndex - windowSessions + 1, endIndex + 1);
        if (!window.every(point => stableMethodology(start, point))) continue;
        const scoreDelta = end.score - start.score;
        const priceReturnPct = ((end.price - start.price) / start.price) * 100;
        const direction = scoreDelta <= -SCORE_PRICE_MIN_SCORE_DELTA && priceReturnPct >= SCORE_PRICE_MIN_PRICE_MOVE_PCT
          ? "falling_score_rising_price" as const
          : scoreDelta >= SCORE_PRICE_MIN_SCORE_DELTA && priceReturnPct <= -SCORE_PRICE_MIN_PRICE_MOVE_PCT
            ? "rising_score_falling_price" as const
            : null;
        if (!direction) continue;
        const dimensionDeltas: Record<string, number | null> = {};
        for (const key of DIMENSION_KEYS) {
          dimensionDeltas[key] = start.scores[key] == null || end.scores[key] == null ? null : end.scores[key]! - start.scores[key]!;
        }
        events.push({
          market: end.market, symbol: end.symbol, windowSessions,
          startObservationId: start.id, endObservationId: end.id,
          startSession: start.session, endSession: end.session, direction,
          scoreDelta, priceReturnPct, dimensionDeltas,
          scoreSource: end.scoreSource, scoringVersion: end.scoringVersion,
          availabilityFingerprint: end.availabilityFingerprint, weightsFingerprint: end.weightsFingerprint,
          isPrimary: windowSessions === SCORE_PRICE_PRIMARY_WINDOW,
        });
      }
    }
  }
  return events;
}

export function summarizeDivergenceOutcomes(rows: Array<{ direction: string; horizon_days: number; benchmark_neutral_return: unknown; end_session: string }>) {
  const groups: Record<string, { n: number; sessions: Set<string>; values: number[] }> = {};
  for (const row of rows) {
    const value = finite(row.benchmark_neutral_return);
    if (value == null) continue;
    const key = `${row.direction}:h${row.horizon_days}`;
    const group = groups[key] ??= { n: 0, sessions: new Set(), values: [] };
    group.n++; group.sessions.add(row.end_session); group.values.push(value);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, {
    events: group.n,
    distinct_sessions: group.sessions.size,
    mean_benchmark_neutral_return: group.values.reduce((sum, value) => sum + value, 0) / group.values.length,
    positive_share: group.values.filter(value => value > 0).length / group.values.length,
  }]));
}
