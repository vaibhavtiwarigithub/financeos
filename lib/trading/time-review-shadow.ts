// Impure shell for the approved time-review exit shadow.
// Writes only the two append-only evidence ledgers. It never updates positions,
// trades, cash, scores, proposals, orders, stops, targets, or mandates.

import { randomUUID } from "node:crypto";
import { fetchUsCandles } from "@/lib/data/candles";
import { fetchYahooCandles } from "@/lib/india-data";
import { CandleResolver, forwardWindow, type LabelCandle } from "@/lib/learning/label-window";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { isPaperScoreFresh } from "@/lib/trading/paper-exit-policy";
import type { TradingMandate } from "@/lib/trading-mandate";
import {
  classifyTimeReview,
  computeTimeReviewOutcome,
  TIME_REVIEW_EXTENSIONS,
  TIME_REVIEW_POLICY_VERSION,
  timeReviewIdempotencyKey,
} from "@/lib/trading/time-review-exit";

export type ReviewMarket = "us" | "india";

// A run is deliberately bounded: each candidate pair may fetch two price
// series, and this route shares a production timeout with its legacy shadow.
// The bound applies *after* completed outcome pairs have been removed from the
// worklist. It must never mean "the oldest 500 observations forever".
export const MAX_TIME_REVIEW_WORKLIST = 500;

export interface TimeReviewMaturationReview {
  id: string;
  policy_version: string;
  review_session: string;
  market: ReviewMarket;
  symbol: string;
  entry_price: number | string;
  review_price: number | string;
  effective_stop_price: number | string | null;
  replacement_candidate_available: boolean | null;
}

export interface TimeReviewMaturationOutcomeKey {
  review_id: string;
  policy_version: string;
  extension_days: number;
}

function maturationKey(reviewId: string, policyVersion: string, extensionDays: number): string {
  return `${reviewId}:${policyVersion}:${extensionDays}`;
}

/**
 * Choose a bounded, pending-only outcome worklist.
 *
 * Completed review/extension pairs are excluded before the cap is applied.
 * When more pending reviews exist than a single run can safely mature, rotate
 * the starting page by UTC day. This prevents a permanently incomplete oldest
 * price window from monopolising every run while remaining deterministic for a
 * given day and ledger state.
 */
export function selectPendingTimeReviewWorklist(
  reviews: TimeReviewMaturationReview[],
  existing: TimeReviewMaturationOutcomeKey[],
  options: { limit?: number; rotationDay?: number } = {},
): TimeReviewMaturationReview[] {
  const limit = options.limit ?? MAX_TIME_REVIEW_WORKLIST;
  if (!Number.isInteger(limit) || limit < 1) return [];
  const done = new Set(existing.map((row) => maturationKey(
    String(row.review_id), String(row.policy_version), Number(row.extension_days),
  )));
  const pending = reviews
    .filter((review) => TIME_REVIEW_EXTENSIONS.some((extensionDays) => !done.has(
      maturationKey(String(review.id), String(review.policy_version), extensionDays),
    )))
    .sort((a, b) => String(a.review_session).localeCompare(String(b.review_session))
      || String(a.id).localeCompare(String(b.id)));
  if (pending.length <= limit) return pending;

  const pages = Math.ceil(pending.length / limit);
  const today = options.rotationDay ?? Math.floor(Date.now() / 86_400_000);
  const page = ((today % pages) + pages) % pages;
  const start = page * limit;
  // Circular slice covers a short final page without wasting the remaining run
  // budget. A review appears at most once because the two slices do not overlap.
  return [...pending.slice(start, start + limit), ...pending.slice(0, Math.max(0, start + limit - pending.length))];
}

export interface ReviewScore {
  score: number | null;
  direction: string | null;
  createdAt: string | null;
}

export interface ReplacementCandidate {
  symbol: string;
  score: number;
}

export async function loadTimeReviewReplacements(
  svc: any,
  markets: ReviewMarket[],
  heldSymbols: Set<string>,
  mandates: Map<string, TradingMandate>,
  now: Date,
): Promise<Map<ReviewMarket, ReplacementCandidate | null | undefined>> {
  const result = new Map<ReviewMarket, ReplacementCandidate | null | undefined>();
  await Promise.all(markets.map(async (market) => {
    const mandate = mandates.get(market);
    if (!mandate) { result.set(market, undefined); return; }
    try {
      const { data, error } = await svc.from("agent_signals")
        .select("symbol,analyst_score,created_at")
        .eq("market", market)
        .eq("score_source", "deterministic_v1")
        .eq("session_validated", true)
        .eq("direction", "long")
        .gte("analyst_score", mandate.score_threshold)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) { result.set(market, undefined); return; }
      const seen = new Set<string>();
      const candidates: ReplacementCandidate[] = [];
      for (const row of data ?? []) {
        const symbol = String(row.symbol).toUpperCase();
        if (seen.has(symbol)) continue;
        seen.add(symbol);
        if (heldSymbols.has(`${market}:${symbol}`)) continue;
        const score = Number(row.analyst_score);
        if (!Number.isFinite(score)) continue;
        if (!isPaperScoreFresh(row.created_at, now, market, mandate.max_signal_age_sessions)) continue;
        candidates.push({ symbol, score });
      }
      candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
      result.set(market, candidates[0] ?? null);
    } catch { result.set(market, undefined); }
  }));
  return result;
}

export async function recordTimeReviewObservation(svc: any, input: {
  runId: string;
  now: Date;
  reviewSession: string;
  market: ReviewMarket;
  position: any;
  ageDays: number;
  horizonDays: number;
  currentPrice: number;
  score: ReviewScore;
  scoreFresh: boolean;
  holdThreshold: number;
  exitThreshold: number;
  mandate: TradingMandate;
  replacement: ReplacementCandidate | null | undefined;
}): Promise<"inserted" | "duplicate" | "skipped" | "failed"> {
  if (input.ageDays !== input.horizonDays || input.position?.position_role === "hedge") return "skipped";
  const entryPrice = Number(input.position.avg_cost);
  const reviewPrice = Number(input.currentPrice);
  const highWaterPrice = Math.max(Number(input.position.highest_price) || 0, reviewPrice);
  const effectiveStopPrice = Number(input.position.stop_loss);
  const initialStopPrice = Number(input.position.initial_stop_loss);
  const classified = classifyTimeReview({
    ageDays: input.ageDays,
    horizonDays: input.horizonDays,
    entryPrice,
    reviewPrice,
    highWaterPrice,
    initialStopPrice,
    effectiveStopPrice,
    targetPrice: Number(input.position.price_target),
    score: input.score.score,
    scoreFresh: input.scoreFresh,
    scoreDirection: input.score.direction,
    holdThreshold: input.holdThreshold,
  });
  // Invalid prices cannot satisfy the table's truth constraints. Their absence
  // remains visible in the monitor's existing price-unavailable diagnostics.
  if (!(entryPrice > 0) || !(reviewPrice > 0) || !(highWaterPrice > 0)) return "skipped";

  const positionId = String(input.position.id);
  const idempotencyKey = timeReviewIdempotencyKey({
    market: input.market,
    positionId,
    reviewSession: input.reviewSession,
  });
  try {
    const { error } = await svc.from("time_review_exit_observations").insert({
      policy_version: TIME_REVIEW_POLICY_VERSION,
      run_id: input.runId,
      idempotency_key: idempotencyKey,
      observed_at: input.now.toISOString(),
      review_session: input.reviewSession,
      market: input.market,
      symbol: String(input.position.symbol),
      position_id: positionId,
      currency: String(input.position.currency ?? (input.market === "india" ? "INR" : "USD")),
      opened_at: String(input.position.opened_at),
      entry_price: entryPrice,
      review_price: reviewPrice,
      unrealized_return_pct: classified.unrealizedReturnPct,
      high_water_price: highWaterPrice,
      drawdown_from_high_pct: classified.drawdownFromHighPct,
      effective_stop_price: Number.isFinite(effectiveStopPrice) && effectiveStopPrice > 0 ? effectiveStopPrice : null,
      initial_stop_distance_pct: classified.initialStopDistancePct,
      resolved_horizon_days: input.horizonDays,
      candidate_extension_days: [...TIME_REVIEW_EXTENSIONS],
      score: input.score.score,
      score_direction: input.score.direction,
      score_observed_at: input.score.createdAt,
      score_fresh: input.scoreFresh,
      hold_threshold: input.holdThreshold,
      exit_threshold: input.exitThreshold,
      candidate_eligible: classified.eligible,
      classification: classified.classification,
      failed_conditions: classified.failed,
      replacement_candidate_available: input.replacement === undefined ? null : input.replacement !== null,
      replacement_symbol: input.replacement?.symbol ?? null,
      replacement_score: input.replacement?.score ?? null,
      mandate_version: input.mandate.version,
      mandate_snapshot: input.position.mandate_snapshot ?? input.mandate,
    });
    if (!error) return "inserted";
    return error.code === "23505" ? "duplicate" : "failed";
  } catch { return "failed"; }
}

function makeResolver(svc: any): CandleResolver {
  return new CandleResolver({
    cache: async (market, symbol, since) => {
      if (market === "india") return [];
      const { data } = await svc.from("price_cache")
        .select("date,close,high,low")
        .eq("symbol", symbol).gte("date", since).order("date", { ascending: true });
      return (data ?? []).map((row: any) => ({
        date: String(row.date), close: Number(row.close),
        high: Number(row.high ?? row.close), low: Number(row.low ?? row.close),
      }));
    },
    provider: async (market, symbol) => {
      if (market === "india") {
        const rows = await fetchYahooCandles(symbol, "3mo");
        return rows.map((row: any) => ({ date: row.date, close: row.close, high: row.high, low: row.low }));
      }
      const result = await fetchUsCandles(symbol, async () => [], 3);
      return result.candles.map((row) => ({ date: row.date, close: row.close, high: row.high, low: row.low }));
    },
  });
}

function benchmarkReturn(bars: LabelCandle[], reviewSession: string, exitSession: string): number | null {
  const entry = bars.find((bar) => bar.date >= reviewSession);
  const exit = bars.find((bar) => bar.date === exitSession);
  if (!entry || !exit || !(entry.close > 0)) return null;
  return ((exit.close - entry.close) / entry.close) * 100;
}

export async function matureTimeReviewOutcomes(
  svc: any,
  market: ReviewMarket | null = null,
): Promise<{ examined: number; inserted: number; skipped: number; providerFetches: number }> {
  // Do not cap the observation read before removing completed pairs. The old
  // oldest-first `.limit(500)` became permanently inert once those rows had
  // both outcomes: every later review was invisible to the maturer.
  const reviews = await fetchAllRows<TimeReviewMaturationReview>((from, to) => {
    let query = svc.from("time_review_exit_observations")
      .select("id,policy_version,review_session,market,symbol,entry_price,review_price,effective_stop_price,replacement_candidate_available")
      // `id` is unique, so range pagination cannot duplicate/skip rows.
      .order("id", { ascending: true }).range(from, to);
    if (market) query = query.eq("market", market);
    return query;
  }, "time-review outcome observations");
  if (!reviews.length) return { examined: 0, inserted: 0, skipped: 0, providerFetches: 0 };

  const existing = await fetchAllRows<TimeReviewMaturationOutcomeKey>((from, to) => {
    let query = svc.from("time_review_exit_outcomes")
      .select("review_id,policy_version,extension_days,time_review_exit_observations!inner(market)")
      .order("review_id", { ascending: true }).order("extension_days", { ascending: true }).range(from, to);
    if (market) query = query.eq("time_review_exit_observations.market", market);
    return query;
  }, "time-review existing outcomes");
  const worklist = selectPendingTimeReviewWorklist(reviews, existing);
  if (!worklist.length) return { examined: 0, inserted: 0, skipped: 0, providerFetches: 0 };
  const done = new Set(existing.map((row) => maturationKey(
    String(row.review_id), String(row.policy_version), Number(row.extension_days),
  )));
  const resolver = makeResolver(svc);
  let examined = 0, inserted = 0, skipped = 0;

  for (const review of worklist) {
    const reviewMarket = String(review.market) as ReviewMarket;
    const reviewSession = String(review.review_session);
    const since = new Date(`${reviewSession}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 5);
    const sinceDate = since.toISOString().slice(0, 10);
    for (const extensionDays of TIME_REVIEW_EXTENSIONS) {
      const key = maturationKey(String(review.id), String(review.policy_version), extensionDays);
      if (done.has(key)) continue;
      examined++;
      try {
        const candles = await resolver.resolve(reviewMarket, String(review.symbol), reviewSession, extensionDays, sinceDate);
        const window = forwardWindow(candles, reviewSession, extensionDays);
        if (!window) { skipped++; continue; }
        const outcome = computeTimeReviewOutcome({
          entryPrice: Number(review.entry_price),
          reviewPrice: Number(review.review_price),
          effectiveStopPrice: review.effective_stop_price == null ? null : Number(review.effective_stop_price),
          forward: window.after,
          extensionDays,
        });
        if (!outcome) { skipped++; continue; }

        const benchmarkSymbol = reviewMarket === "india" ? "^NSEI" : "SPY";
        const benchmarkCandles = await resolver.resolve(reviewMarket, benchmarkSymbol, reviewSession, extensionDays, sinceDate);
        const benchmarkPct = benchmarkReturn(benchmarkCandles, reviewSession, outcome.candidateExitSession);
        const { error: insertError } = await svc.from("time_review_exit_outcomes").insert({
          review_id: review.id,
          policy_version: review.policy_version,
          extension_days: extensionDays,
          baseline_exit_session: outcome.baselineExitSession,
          baseline_exit_price: outcome.baselineExitPrice,
          baseline_total_return_pct: outcome.baselineTotalReturnPct,
          baseline_review_return_pct: outcome.baselineReviewReturnPct,
          candidate_exit_session: outcome.candidateExitSession,
          candidate_exit_price: outcome.candidateExitPrice,
          candidate_total_return_pct: outcome.candidateTotalReturnPct,
          candidate_review_return_pct: outcome.candidateReviewReturnPct,
          benchmark_return_pct: benchmarkPct,
          benchmark_relative_return_pct: benchmarkPct == null ? null : outcome.candidateReviewReturnPct - benchmarkPct,
          incremental_vs_baseline_pct: outcome.incrementalVsBaselinePct,
          max_favorable_excursion_pct: outcome.maxFavorableExcursionPct,
          max_adverse_excursion_pct: outcome.maxAdverseExcursionPct,
          mechanical_stop_hit: outcome.mechanicalStopHit,
          mechanical_stop_session: outcome.mechanicalStopSession,
          replacement_candidate_available: review.replacement_candidate_available,
          estimated_incremental_cost_pct: 0,
        });
        if (!insertError || insertError.code === "23505") inserted++;
        else skipped++;
      } catch { skipped++; }
    }
  }
  return { examined, inserted, skipped, providerFetches: resolver.providerFetches };
}
