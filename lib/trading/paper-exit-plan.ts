import { isPaperScoreFresh, marketSessionsSince, paperPositionOpenedAt, resolvePaperExitThreshold } from "@/lib/trading/paper-exit-policy";
import { tradingWeekdaysBetween } from "@/lib/trading-mandate";

export type PaperExitPlanState =
  | "hold"
  | "time_exit_due"
  | "score_exit_due"
  | "stop_exit_due"
  | "target_exit_due";

export interface PaperExitPlan {
  positionId: string;
  symbol: string;
  market: "us" | "india";
  currentPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  score: number | null;
  scoreCreatedAt: string | null;
  scoreAgeSessions: number | null;
  scoreFresh: boolean;
  scoreExitThreshold: number;
  maxScoreAgeSessions: number;
  ageWeekdays: number | null;
  horizonDays: number;
  horizonSource: "entry" | "user" | "champion" | "hedge_default";
  isHedge: boolean;
  state: PaperExitPlanState;
}

export interface ProjectPaperExitPlanInput {
  position: {
    id?: string | null;
    symbol: string;
    market?: string | null;
    current_price?: unknown;
    stop_loss?: unknown;
    price_target?: unknown;
    opened_at?: string | null;
    created_at?: string | null;
    position_role?: string | null;
  };
  signal?: {
    analyst_score?: unknown;
    created_at?: string | null;
  } | null;
  entryThreshold: number;
  hysteresis: number;
  maxScoreAgeSessions: number;
  horizonDays: number;
  horizonSource: PaperExitPlan["horizonSource"];
  now: Date;
}

export function resolvePaperPositionHorizon(input: {
  storedHorizon: unknown;
  isHedge: boolean;
  existingPositionsPolicy: "grandfather" | "apply";
  currentHorizonDays: number;
  currentHorizonSource: "user" | "champion";
}): { days: number; source: PaperExitPlan["horizonSource"] } {
  const stored = Number(input.storedHorizon);
  const hasStoredHorizon = Number.isFinite(stored) && stored >= (input.isHedge ? 1 : 2);
  if (input.isHedge) {
    return hasStoredHorizon
      ? { days: stored, source: "entry" }
      : { days: 5, source: "hedge_default" };
  }
  if (input.existingPositionsPolicy !== "apply" && hasStoredHorizon) {
    return { days: stored, source: "entry" };
  }
  return { days: input.currentHorizonDays, source: input.currentHorizonSource };
}

function finiteNumber(value: unknown, positiveOnly = false): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || (positiveOnly && n <= 0)) return null;
  return n;
}

export function projectPaperExitPlan(input: ProjectPaperExitPlanInput): PaperExitPlan {
  const { position, signal, now } = input;
  const market = position.market === "india" ? "india" : "us";
  const isHedge = position.position_role === "hedge";
  const currentPrice = finiteNumber(position.current_price, true);
  const stopPrice = finiteNumber(position.stop_loss, true);
  const targetPrice = finiteNumber(position.price_target, true);
  const score = finiteNumber(signal?.analyst_score);
  const scoreCreatedAt = signal?.created_at ?? null;
  const maxScoreAgeSessions = Number.isInteger(input.maxScoreAgeSessions) && input.maxScoreAgeSessions >= 0
    ? input.maxScoreAgeSessions
    : 2;
  const scoreFresh = !isHedge && score != null
    && isPaperScoreFresh(scoreCreatedAt, now, market, maxScoreAgeSessions);
  const rawScoreAge = scoreCreatedAt ? marketSessionsSince(scoreCreatedAt, now, market) : Number.POSITIVE_INFINITY;
  const scoreAgeSessions = Number.isFinite(rawScoreAge) ? rawScoreAge : null;
  const scoreExitThreshold = resolvePaperExitThreshold(input.entryThreshold, input.hysteresis);
  const openedAt = paperPositionOpenedAt(position);
  const ageWeekdays = openedAt ? tradingWeekdaysBetween(new Date(openedAt), now) : null;
  const horizonDays = Number.isFinite(input.horizonDays) && input.horizonDays >= 1
    ? Math.round(input.horizonDays)
    : 10;

  // Match PositionMonitor's current exit precedence. This is a read-only
  // projection over persisted state; PositionMonitor remains execution authority.
  let state: PaperExitPlanState = "hold";
  if (ageWeekdays != null && ageWeekdays > horizonDays) state = "time_exit_due";
  else if (scoreFresh && score != null && score < scoreExitThreshold) state = "score_exit_due";
  else if (currentPrice != null && stopPrice != null && currentPrice <= stopPrice) state = "stop_exit_due";
  else if (!isHedge && currentPrice != null && targetPrice != null && currentPrice >= targetPrice) state = "target_exit_due";

  return {
    positionId: String(position.id ?? `${market}:${position.symbol}`),
    symbol: String(position.symbol),
    market,
    currentPrice,
    stopPrice,
    targetPrice,
    score,
    scoreCreatedAt,
    scoreAgeSessions,
    scoreFresh,
    scoreExitThreshold,
    maxScoreAgeSessions,
    ageWeekdays,
    horizonDays,
    horizonSource: input.horizonSource,
    isHedge,
    state,
  };
}
