// Deterministic risk-tier composite — measure-only shadow (2026-09-18).
// Adapted from the disclosed scoring shape of github.com/achaljhawar/1rok's
// risk agent (base 30, component maxes volatility 30 / fragility 30 /
// concentration 20 / macro 15 / special 20 [1rok: 25, capped so components
// cannot exceed 100 with the base], tiers LOW<=30/MODERATE<=50/HIGH<=70/
// VERY_HIGH>70). Their version is LLM-judged; this is 100% deterministic off
// data ResearchAgent already fetches (fundamental overview, technicals, macro
// regime, earnings calendar) — no new provider, no LLM.
//
// Special risk also folds in short-interest squeeze setup (2026-09-18,
// item #? of the achaljhawar/1rok fast-follow list — Yahoo-only data,
// Finnhub free tier has none; see lib/data/fundamentals.ts BONUS_COPY_ONLY).
//
// SHADOW ONLY: written to decision_observations.features.risk_tier_shadow.
// Not read by scoring, sizing, gating, or any order path. Promotion to a real
// pre-trade veto is a separate future decision (see
// features/risk-tier-gate/FEATURE_ARCHITECTURE.md), same discipline as every
// other new signal in this codebase.
//
// IMPORTANT ASYMMETRY, stated not hidden: this is an additive penalty system,
// not a renormalized weighted average like analyst_score. A component with no
// evidence contributes ZERO risk points (not a neutral default), so a symbol
// with thin data reads LOWER risk than one with full data showing the same
// real risk — the opposite bias from analyst_score's "abstain when thin"
// convention. `coverage` reports how many of the 5 components were available
// so a consumer can tell "low risk" from "low evidence." This must be fixed
// (or at minimum required at a coverage floor) before any future promotion to
// a real gate.

export type RiskTier = "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH";
export type Investability = "full" | "medium" | "small" | "not_investable";

export interface RiskTierInput {
  /** AV COMPANY_OVERVIEW "Beta". Null when missing. */
  beta: number | null;
  /** Last completed bar's move in ATR multiples (lib/data/technicals.ts atrMultipleMove). */
  atrMultipleMove: number | null;
  /** Fraction, e.g. 2.5 = 250% debt/equity. */
  debtToEquity: number | null;
  /** Fraction, e.g. -0.05 = -5% margin. */
  profitMargin: number | null;
  /** Fraction, e.g. 0.12 = 12% gross margin. */
  grossMargin: number | null;
  /** True when the instrument family is a diversified fund (ETF-like) — concentration risk is near-zero by construction rather than unavailable. */
  isDiversifiedFund: boolean;
  /** MacroSentinel danger_score 0-100, US-only. Null when unavailable (India, stale, no verdict — same gate as macro_score). */
  macroDangerScore: number | null;
  /** Calendar days to the next known earnings report. Null when unknown. */
  daysToEarnings: number | null;
  /** Whether the technical breakdown veto fired for this bar (lib/data/technicals.ts detectBreakdownVeto). */
  breakdownVetoed: boolean;
  /** Yahoo defaultKeyStatistics shortPercentOfFloat, fraction (0.20 = 20%). Null — Finnhub has no equivalent (2026-09-18). */
  shortPercentFloat: number | null;
  /** Yahoo shortRatio — "days to cover" at average volume. Null when unavailable. */
  daysToCoverShort: number | null;
}

export interface RiskTierResult {
  version: "risk-tier.v1";
  volatilityRisk: number | null;   // 0-30
  fragilityRisk: number | null;    // 0-30
  concentrationRisk: number | null;// 0-20
  macroRisk: number | null;        // 0-15
  specialRisk: number | null;      // 0-20
  totalRisk: number;               // 0-100, base 30 + available components, capped
  coverage: number;                // 0-5, count of available components
  tier: RiskTier;
  investability: Investability;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function tierOf(total: number): RiskTier {
  if (total <= 30) return "LOW";
  if (total <= 50) return "MODERATE";
  if (total <= 70) return "HIGH";
  return "VERY_HIGH";
}

function investabilityOf(total: number): Investability {
  if (total > 85) return "not_investable";
  if (total >= 70) return "small";
  if (total >= 50) return "medium";
  return "full";
}

export function computeRiskTier(input: RiskTierInput): RiskTierResult {
  let volatilityRisk: number | null = null;
  if (input.beta != null || input.atrMultipleMove != null) {
    const betaPoints = input.beta == null ? null
      : input.beta > 1.5 ? 30 : input.beta > 1.2 ? 20 : input.beta > 0.8 ? 10 : 5;
    const atrPoints = input.atrMultipleMove == null ? null
      : clamp(Math.abs(input.atrMultipleMove) * 10, 0, 30);
    const parts = [betaPoints, atrPoints].filter((v): v is number => v != null);
    volatilityRisk = parts.reduce((a, b) => a + b, 0) / parts.length;
  }

  let fragilityRisk: number | null = null;
  if (input.debtToEquity != null || input.profitMargin != null || input.grossMargin != null) {
    let f = 0;
    if (input.debtToEquity != null) f += input.debtToEquity > 2 ? 15 : input.debtToEquity > 1 ? 8 : 0;
    if (input.profitMargin != null) f += input.profitMargin < 0 ? 15 : input.profitMargin < 0.05 ? 8 : 0;
    if (input.grossMargin != null) f += input.grossMargin < 0.15 ? 5 : 0;
    fragilityRisk = clamp(f, 0, 30);
  }

  // No segment/customer-concentration data source exists in this codebase yet.
  // A diversified fund gets a real near-zero value (available); a single name
  // is honestly UNAVAILABLE, not guessed — same convention as insider/macro
  // availability elsewhere in this scorer.
  const concentrationRisk: number | null = input.isDiversifiedFund ? 2 : null;

  const macroRisk: number | null = input.macroDangerScore == null
    ? null
    : clamp((input.macroDangerScore / 100) * 15, 0, 15);

  let specialRisk: number | null = null;
  if (input.daysToEarnings != null || input.breakdownVetoed || input.shortPercentFloat != null) {
    let s = 0;
    if (input.daysToEarnings != null && input.daysToEarnings >= 0 && input.daysToEarnings <= 5) s += 15;
    if (input.breakdownVetoed) s += 15;
    // Squeeze setup: a lot of float short (>20%) that would also take a long
    // time to cover (>5 days) at average volume is the classic short-squeeze
    // precondition (1rok's risk agent lists this under "special situational
    // risks"). High % alone with fast cover is not the same risk shape.
    if (input.shortPercentFloat != null && input.shortPercentFloat > 0.20) {
      s += input.daysToCoverShort != null && input.daysToCoverShort > 5 ? 10 : 5;
    }
    specialRisk = clamp(s, 0, 20);
  }

  const components = [volatilityRisk, fragilityRisk, concentrationRisk, macroRisk, specialRisk];
  const coverage = components.filter((c) => c != null).length;
  const sum = components.reduce<number>((a, b) => a + (b ?? 0), 0);
  const totalRisk = clamp(30 + sum, 0, 100);

  return {
    version: "risk-tier.v1",
    volatilityRisk, fragilityRisk, concentrationRisk, macroRisk, specialRisk,
    totalRisk, coverage,
    tier: tierOf(totalRisk),
    investability: investabilityOf(totalRisk),
  };
}
