import type { CryptoScoreResult } from "./crypto-score";

export type CryptoCandidateEligibility = { admitted: true; reason: null } | { admitted: false; reason: string };

/**
 * The one admission predicate for the native crypto research lane. This is not
 * a paper or live-order permission: it answers only whether a frozen research
 * observation is a valid candidate for later measurement.
 */
export function classifyCryptoCandidate(input: {
  pairInventoryObserved: boolean;
  accountEligible: boolean;
  brokerTradeable: boolean;
  hasExecutableQuote: boolean;
  historyDeferred: boolean;
  historyDays: number;
  observedSession: string | null;
  expectedSession: string;
  hasEvidence: boolean;
  score: CryptoScoreResult | null;
}): CryptoCandidateEligibility {
  if (!input.pairInventoryObserved) return { admitted: false, reason: "broker_pair_inventory_not_observed" };
  if (!input.accountEligible) return { admitted: false, reason: "broker_account_eligibility_not_observed" };
  if (!input.brokerTradeable) return { admitted: false, reason: "broker_pair_not_explicitly_tradeable" };
  if (!input.hasExecutableQuote) return { admitted: false, reason: "broker_executable_quote_not_observed" };
  if (input.historyDeferred) return { admitted: false, reason: "history_capture_deferred_by_bounded_research_budget" };
  if (!Number.isFinite(input.historyDays) || input.historyDays < 90) return { admitted: false, reason: "insufficient_completed_daily_history" };
  if (input.observedSession !== input.expectedSession) return { admitted: false, reason: "daily_candle_unavailable_or_stale" };
  if (!input.hasEvidence) return { admitted: false, reason: "insufficient_or_invalid_daily_history" };
  if (!input.score) return { admitted: false, reason: "native_score_unavailable" };
  if (!input.score.ok) return { admitted: false, reason: input.score.reason };
  return { admitted: true, reason: null };
}

/** Paper research requires reproducible public market data, not a live-broker credential. */
export function classifyCryptoPaperCandidate(input: Omit<Parameters<typeof classifyCryptoCandidate>[0], "pairInventoryObserved" | "accountEligible" | "brokerTradeable" | "hasExecutableQuote"> & { hasMarketQuote: boolean }): CryptoCandidateEligibility {
  if (!input.hasMarketQuote) return { admitted: false, reason: "public_two_sided_quote_unavailable" };
  if (input.historyDeferred) return { admitted: false, reason: "history_capture_deferred_by_bounded_research_budget" };
  if (!Number.isFinite(input.historyDays) || input.historyDays < 90) return { admitted: false, reason: "insufficient_completed_daily_history" };
  if (input.observedSession !== input.expectedSession) return { admitted: false, reason: "daily_candle_unavailable_or_stale" };
  if (!input.hasEvidence) return { admitted: false, reason: "insufficient_or_invalid_daily_history" };
  if (!input.score) return { admitted: false, reason: "native_score_unavailable" };
  if (!input.score.ok) return { admitted: false, reason: input.score.reason };
  return { admitted: true, reason: null };
}
