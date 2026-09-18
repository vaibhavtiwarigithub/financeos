import { describe, expect, it } from "vitest";
import { classifyCryptoCandidate, classifyCryptoPaperCandidate } from "./crypto-candidate";

const eligible = () => classifyCryptoCandidate({
  pairInventoryObserved: true, accountEligible: true, brokerTradeable: true,
  hasExecutableQuote: true, historyDeferred: false, historyDays: 90,
  observedSession: "2026-09-16", expectedSession: "2026-09-16", hasEvidence: true,
  score: { ok: true, score: 72, components: { trend: 70, structure: 75, volatility: 70 }, version: "crypto-score-shadow-v1" },
});

describe("native crypto candidate admission", () => {
  it("admits only a fully broker-verified, mature, fresh, liquid score", () => {
    expect(eligible()).toEqual({ admitted: true, reason: null });
  });

  it("refuses a quote without explicit broker pair tradability", () => {
    expect(classifyCryptoCandidate({
      pairInventoryObserved: true, accountEligible: true, brokerTradeable: false,
      hasExecutableQuote: true, historyDeferred: false, historyDays: 100,
      observedSession: "2026-09-16", expectedSession: "2026-09-16", hasEvidence: true,
      score: { ok: true, score: 72, components: { trend: 70, structure: 75, volatility: 70 }, version: "crypto-score-shadow-v1" },
    })).toEqual({ admitted: false, reason: "broker_pair_not_explicitly_tradeable" });
  });

  it("refuses history below the 90-session contract even when the score is high", () => {
    const result = classifyCryptoCandidate({
      pairInventoryObserved: true, accountEligible: true, brokerTradeable: true,
      hasExecutableQuote: true, historyDeferred: false, historyDays: 89,
      observedSession: "2026-09-16", expectedSession: "2026-09-16", hasEvidence: true,
      score: { ok: true, score: 100, components: { trend: 100, structure: 100, volatility: 100 }, version: "crypto-score-shadow-v1" },
    });
    expect(result).toEqual({ admitted: false, reason: "insufficient_completed_daily_history" });
  });

  it("keeps paper evidence independent of a missing live broker quote", () => {
    expect(classifyCryptoPaperCandidate({ historyDeferred: false, historyDays: 100, observedSession: "2026-09-16", expectedSession: "2026-09-16", hasEvidence: true, hasMarketQuote: true, score: { ok: true, score: 72, components: { trend: 70, structure: 75, volatility: 70 }, version: "crypto-score-shadow-v1" } })).toEqual({ admitted: true, reason: null });
  });
});
