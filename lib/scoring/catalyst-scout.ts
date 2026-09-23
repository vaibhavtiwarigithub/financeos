// Deterministic catalyst composite — measure-only shadow (2026-09-18).
// Adapted from the disclosed scoring shape of github.com/achaljhawar/1rok's
// Catalyst agent (base 50, components earnings-setup ±20/+25, expectation
// asymmetry -15/+20, non-earnings catalyst -10/+15, insider signal ±10, event
// risk penalty -25/0). Their version is LLM-judged and reads live news/IV via
// tool calls; this is 100% deterministic off data ResearchAgent already has in
// scope for every symbol it scores — daysToEarnings, the Finnhub analyst
// consensus (lib/data/analyst.ts, already fetched but currently only LOGGED,
// never scored — see the comment at its call site), the existing insider_score,
// and Webull's already-fetched 5-day capital-flow net. No new provider, no LLM.
//
// SHADOW ONLY: written to decision_observations.features.catalyst_shadow. Not
// read by scoring, sizing, gating, or any order path. Promotion is a separate
// future decision, same discipline as risk-tier-gate (lib/risk/risk-tier.ts).
//
// Same additive-penalty asymmetry as risk-tier: a missing signal contributes
// zero, not a neutral default, so `coverage` travels with every row.

export type CatalystClassification = "bullish_catalyst" | "bearish_catalyst" | "neutral" | "high_risk_binary_event";

export interface CatalystInput {
  /** Calendar days to the next known earnings report. Null when unknown. */
  daysToEarnings: number | null;
  /** lib/data/analyst.ts scoreAnalyst() weighted consensus, 0-100, 50=neutral. Null when unavailable/uncovered. */
  analystConsensusScore: number | null;
  /** ResearchAgent's insider_score, 0-100, 50=neutral. */
  insiderScore: number | null;
  /** Whether the insider dimension was actually available (not the default-fill 50). */
  insiderAvailable: boolean;
  /** Webull capital-flow net over 5 days (raw $ or index units — sign is what matters here). Null when unavailable. */
  capitalFlow5d: number | null;
  /** Whether the technical breakdown veto fired for this bar (lib/data/technicals.ts detectBreakdownVeto). */
  breakdownVetoed: boolean;
}

export interface CatalystResult {
  version: "catalyst-scout.v1";
  earningsSetup: number | null;        // -20..+25
  expectationAsymmetry: number | null; // -15..+20
  nonEarningsCatalyst: number | null;  // -10..+15
  insiderSignal: number | null;        // -10..+10
  eventRiskPenalty: number;            // -25..0, always computed (0 default, penalty-only)
  totalScore: number;                  // 0-100, base 50 + available components, capped
  coverage: number;                    // 0-4, count of available evidence-gated components
  classification: CatalystClassification;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function computeCatalystScout(input: CatalystInput): CatalystResult {
  const EARNINGS_WINDOW_DAYS = 10;
  const RISK_WINDOW_DAYS = 5;

  let earningsSetup: number | null = null;
  if (input.daysToEarnings != null) {
    if (input.daysToEarnings > EARNINGS_WINDOW_DAYS) {
      earningsSetup = 0; // known, but not near-term — no setup signal yet
    } else {
      const skew = (input.analystConsensusScore ?? 50) - 50; // -50..+50
      earningsSetup = skew >= 0 ? clamp((skew / 50) * 25, 0, 25) : clamp((skew / 50) * 20, -20, 0);
    }
  }

  let expectationAsymmetry: number | null = null;
  if (input.analystConsensusScore != null) {
    const skew = input.analystConsensusScore - 50;
    expectationAsymmetry = skew >= 0 ? clamp((skew / 50) * 20, 0, 20) : clamp((skew / 50) * 15, -15, 0);
  }

  let nonEarningsCatalyst: number | null = null;
  if (input.capitalFlow5d != null && Number.isFinite(input.capitalFlow5d)) {
    nonEarningsCatalyst = input.capitalFlow5d > 0 ? 8 : input.capitalFlow5d < 0 ? -6 : 0;
  }

  let insiderSignal: number | null = null;
  if (input.insiderAvailable && input.insiderScore != null) {
    const skew = input.insiderScore - 50;
    insiderSignal = clamp((skew / 50) * 10, -10, 10);
  }

  let eventRiskPenalty = 0;
  const earningsImminent = input.daysToEarnings != null && input.daysToEarnings >= 0 && input.daysToEarnings <= RISK_WINDOW_DAYS;
  if (earningsImminent) eventRiskPenalty -= 15;
  if (input.breakdownVetoed) eventRiskPenalty -= 10;
  eventRiskPenalty = clamp(eventRiskPenalty, -25, 0);

  const gatedComponents = [earningsSetup, expectationAsymmetry, nonEarningsCatalyst, insiderSignal];
  const coverage = gatedComponents.filter((c) => c != null).length;
  const sum = gatedComponents.reduce<number>((a, b) => a + (b ?? 0), 0) + eventRiskPenalty;
  const totalScore = clamp(50 + sum, 0, 100);

  const classification: CatalystClassification =
    eventRiskPenalty <= -20 ? "high_risk_binary_event"
    : totalScore >= 65 ? "bullish_catalyst"
    : totalScore <= 35 ? "bearish_catalyst"
    : "neutral";

  return {
    version: "catalyst-scout.v1",
    earningsSetup, expectationAsymmetry, nonEarningsCatalyst, insiderSignal,
    eventRiskPenalty, totalScore, coverage, classification,
  };
}
