/**
 * Deterministic Score Computation — Phase 0
 * All 5 sub-scores derived from real fetched data. No LLM number generation.
 * LLM only receives computed scores + evidence to write thesis and direction.
 */

import { computeTechnicals, scoreTechnicals } from "./technicals";
import type { DeterministicQuote } from "./quotes";
import { writeEvidence, writeBatchEvidence } from "./evidence";

export interface ScoreEvidence {
  fundamental: Record<string, unknown>;
  technical: Record<string, unknown>;
  sentiment: Record<string, unknown>;
  macro: Record<string, unknown>;
  insider: Record<string, unknown>;
}

export interface ComputedScores {
  fundamental_score: number;
  technical_score: number;
  sentiment_score: number;
  macro_score: number;
  insider_score: number;
  evidence: ScoreEvidence;
  dataQuality: {
    fundamentalDataAvailable: boolean;
    technicalDataPoints: number;
    sentimentDataAvailable: boolean;
    macroDataAvailable: boolean;
    insiderDataAvailable: boolean;
  };
}

// ── Fundamental scoring from AV OVERVIEW ──────────────────────────────────────

// Requires at least 2 of the real valuation/quality fields to be present before
// treating fundamentals as "available." AV's OVERVIEW only returns a populated
// object when the symbol resolves, so `!!overview.Symbol` was a reasonable
// proxy there — but lib/india-data.ts's Yahoo mapper always sets `Symbol` on
// any quoteSummary hit, even when every real field (P/E, margin, ROE, etc.) is
// empty, which made sparse Yahoo responses look like real evidence.
const FUNDAMENTAL_FIELDS = ["PERatio", "ProfitMargin", "ReturnOnEquityTTM", "EPS", "QuarterlyRevenueGrowthYOY"] as const;
export function hasMinFundamentalFields(overview: Record<string, string> | null | undefined, min = 2): boolean {
  if (!overview) return false;
  let count = 0;
  for (const f of FUNDAMENTAL_FIELDS) {
    const v = parseFloat(overview[f] ?? "");
    if (!isNaN(v)) count++;
  }
  return count >= min;
}

function scoreFundamentals(overview: Record<string, string>, isEtf: boolean): { score: number; evidence: Record<string, unknown> } {
  if (isEtf) {
    // ETFs have no P/E/earnings — use a neutral baseline (momentum drives the score elsewhere).
    return { score: 55, evidence: { note: "ETF — no company fundamentals; neutral 55 baseline" } };
  }
  if (!overview?.Symbol) {
    // A real stock whose fundamentals just weren't fetched (rate limit / no key).
    // This must NOT masquerade as an ETF — say plainly the data was missing so
    // the score-detail "why" is honest about it being a low-confidence default.
    return { score: 55, evidence: { note: "No fundamental data available (provider rate limit or missing key) — neutral 55 baseline, low confidence" } };
  }

  let score = 50;
  const evidence: Record<string, unknown> = {};

  const pe = parseFloat(overview.PERatio ?? "");
  if (!isNaN(pe) && pe > 0) {
    evidence.pe_ratio = pe;
    // P/E 25-40 was previously unscored (a cliff: 24.99->+10, 25->0, 40.01->-15),
    // making a fairly-priced P/E=30 stock indistinguishable from no-data-neutral.
    if (pe < 15) score += 20;
    else if (pe < 25) score += 10;
    else if (pe < 40) score -= 5;
    else if (pe < 60) score -= 15;
    else score -= 25;
  }

  const profitMargin = parseFloat(overview.ProfitMargin ?? "");
  if (!isNaN(profitMargin)) {
    evidence.profit_margin = profitMargin;
    if (profitMargin > 0.20) score += 20;
    else if (profitMargin > 0.10) score += 10;
    else if (profitMargin < 0) score -= 20;
  }

  const roe = parseFloat(overview.ReturnOnEquityTTM ?? "");
  if (!isNaN(roe)) {
    evidence.roe = roe;
    if (roe > 0.20) score += 15;
    else if (roe > 0.10) score += 8;
    else if (roe < 0) score -= 10;
  }

  const eps = parseFloat(overview.EPS ?? "");
  if (!isNaN(eps)) {
    evidence.eps = eps;
    if (eps > 0) score += 5;
    else score -= 10;
  }

  // Revenue growth YOY (52W high vs current as a crude proxy if not available)
  const revGrowth = parseFloat(overview.QuarterlyRevenueGrowthYOY ?? "");
  if (!isNaN(revGrowth)) {
    evidence.revenue_growth_yoy = revGrowth;
    if (revGrowth > 0.20) score += 15;
    else if (revGrowth > 0.10) score += 8;
    else if (revGrowth < 0) score -= 10;
  }

  // Analyst target vs current price
  const target = parseFloat(overview.AnalystTargetPrice ?? "");
  const current52wk = parseFloat(overview["52WeekHigh"] ?? "");
  if (!isNaN(target) && target > 0) {
    evidence.analyst_target = target;
  }

  evidence.symbol = overview.Symbol;
  evidence.sector = overview.Sector;
  evidence.industry = overview.Industry;

  return { score: Math.max(0, Math.min(100, Math.round(score))), evidence };
}

// ── Sentiment scoring (normalize existing fetchSocialSentiment output) ─────────

export function scoreSentiment(socialResult: any): { score: number; evidence: Record<string, unknown> } {
  if (!socialResult) return { score: 50, evidence: { note: "no sentiment data" } };

  // socialResult may have: bullish_pct, bearish_pct, sentiment_score (0-100), bull_bear_ratio
  const sentScore = socialResult.sentiment_score;
  if (typeof sentScore === "number" && sentScore >= 0 && sentScore <= 100) {
    return { score: Math.round(sentScore), evidence: { source: "social", raw: socialResult } };
  }

  // Real shape from fetchSocialSentiment (research-agent.ts): stocktwits_bullish_pct /
  // stocktwits_bearish_pct, already on a 0-100 scale (e.g. 100 = 100% bullish) — this
  // block previously checked bullish_pct/bull_pct (never present) and multiplied by
  // 100 assuming a 0-1 fraction, so it always fell through to the neutral-50 default
  // below even when StockTwits showed e.g. 100% bullish / 0% bearish.
  const bull = socialResult.stocktwits_bullish_pct ?? socialResult.bullish_pct ?? socialResult.bull_pct ?? null;
  const bear = socialResult.stocktwits_bearish_pct ?? socialResult.bearish_pct ?? socialResult.bear_pct ?? null;
  if (bull != null && bear != null) {
    // bull/bear already 0-100; weight by message volume isn't available here, so
    // use bullish share of the two directional percentages as the score.
    const total = bull + bear;
    const score = total > 0 ? Math.round((bull / total) * 100) : 50;
    return { score: Math.max(0, Math.min(100, score)), evidence: { bullish_pct: bull, bearish_pct: bear } };
  }

  // Fall back to Alpha Vantage news sentiment (-1..+1) if StockTwits pct is missing.
  const avSent = socialResult.av_news_sentiment;
  if (typeof avSent === "number") {
    const score = Math.round((avSent + 1) * 50); // -1 -> 0, 0 -> 50, +1 -> 100
    return { score: Math.max(0, Math.min(100, score)), evidence: { av_news_sentiment: avSent, source: "av_news" } };
  }

  // Last resort: the LLM-facing overall_sentiment label, if that's all that's present.
  if (typeof socialResult.overall_sentiment === "string") {
    const label = socialResult.overall_sentiment.toLowerCase();
    const score = label.includes("bull") ? 65 : label.includes("bear") ? 35 : 50;
    return { score, evidence: { overall_sentiment: socialResult.overall_sentiment, source: "label_fallback" } };
  }

  return { score: 50, evidence: { note: "sentiment format unknown", raw: socialResult } };
}

// ── Macro scoring from macro_regime (MacroSentinel's weekly regime assessment) ─
// danger_score/regime live on macro_regime (migration 028), NOT macro_signals —
// macro_signals holds per-indicator rows (one per indicator per week, no
// danger_score/regime columns at all). Querying macro_signals for those columns
// always errors, so macro silently fell back to "macro query failed" -> neutral
// 50 -> excluded every single run, meaning the macro dimension never contributed
// real signal despite MacroSentinel running weekly and populating macro_regime.

async function fetchMacroScore(supabase: any): Promise<{ score: number; evidence: Record<string, unknown> }> {
  try {
    const { data } = await supabase
      .from("macro_regime")
      .select("danger_score, regime, week_of")
      .order("week_of", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return { score: 50, evidence: { note: "no macro data" } };

    const dangerScore = data.danger_score ?? 50;
    const regime = data.regime ?? "unknown";

    // A regime of "unknown" means MacroSentinel itself couldn't classify this
    // run (e.g. too few indicators fetched) — its danger_score in that case is
    // a placeholder 0, NOT a real "calm markets" read. Scoring that as 100
    // (maximally bullish, full confidence) silently made every symbol's macro
    // dimension pin to 100 whenever MacroSentinel's weekly run failed, with no
    // availability flag to catch it. Treat "unknown" as no verdict = unavailable.
    if (String(regime).toLowerCase() === "unknown") {
      return {
        score: 50,
        evidence: { danger_score: dangerScore, regime, note: "MacroSentinel reported no verdict this run — treated as unavailable", source: "macro_sentinel", as_of: data.week_of },
      };
    }

    // Convert danger score (0-100 where 100 = most dangerous) to macro_score (0-100 where 100 = bullish)
    const macroScore = Math.round(100 - dangerScore);

    return {
      score: Math.max(0, Math.min(100, macroScore)),
      evidence: { danger_score: dangerScore, regime, source: "macro_sentinel", as_of: data.week_of },
    };
  } catch {
    return { score: 50, evidence: { note: "macro query failed" } };
  }
}

// ── Insider scoring (reuse existing scoreInsider output) ──────────────────────

export function normalizeInsiderScore(insiderResult: any): { score: number; evidence: Record<string, unknown>; available: boolean } {
  if (!insiderResult) return { score: 50, evidence: { note: "no insider data" }, available: false };
  if (typeof insiderResult === "number") return { score: Math.max(0, Math.min(100, insiderResult)), evidence: {}, available: true };
  const score = insiderResult.score ?? insiderResult.insider_score ?? 50;
  // scoreInsider() (research-agent.ts) sets `available: false` for no-data/
  // fetch-failed/rate-limited outcomes, which all otherwise return the same
  // neutral score:50 shape — `available` is the only field that tells them
  // apart from genuinely-balanced real insider activity. Fail CLOSED when the
  // field is missing entirely (an unrecognized shape is a data-quality
  // problem, not evidence of real balanced insider activity).
  const available = typeof insiderResult.available === "boolean" ? insiderResult.available : false;
  return { score: Math.max(0, Math.min(100, Math.round(score))), evidence: insiderResult, available };
}

// ── Master score computation ──────────────────────────────────────────────────

export async function computeScores(opts: {
  symbol: string;
  isEtf: boolean;
  avOverview: Record<string, string>;
  candles: { date: string; close: number; high: number; low: number; open: number; volume: number }[];
  socialResult: any;
  insiderResult: any;
  supabase: any;
}): Promise<ComputedScores> {
  const { symbol, isEtf, avOverview, candles, socialResult, insiderResult, supabase } = opts;

  // Compute all scores deterministically
  const { score: fundamental_score, evidence: fundEvidence } = scoreFundamentals(avOverview, isEtf);

  const technicals = computeTechnicals(candles);
  const technical_score = scoreTechnicals(technicals);
  const techEvidence = { ...technicals, dataPoints: candles.length };

  const { score: sentiment_score, evidence: sentEvidence } = scoreSentiment(socialResult);

  const { score: macro_score, evidence: macroEvidence } = await fetchMacroScore(supabase);

  const { score: insider_score, evidence: insiderEvidence, available: insiderAvailable } = normalizeInsiderScore(insiderResult);

  const result: ComputedScores = {
    fundamental_score,
    technical_score,
    sentiment_score,
    macro_score,
    insider_score,
    evidence: {
      fundamental: { ...fundEvidence, symbol, is_etf: isEtf },
      technical: techEvidence,
      sentiment: sentEvidence,
      macro: macroEvidence,
      insider: insiderEvidence,
    },
    dataQuality: {
      // isEtf is INAPPLICABLE (structural), not merely unavailable — kept
      // separate from real per-symbol fundamental fetch success so a sparse
      // Yahoo/AV response can't masquerade as real evidence.
      fundamentalDataAvailable: isEtf || hasMinFundamentalFields(avOverview),
      technicalDataPoints: candles.length,
      // socialResult is ALWAYS a non-null object (fetchSocialSentiment never
      // returns null) — has_data is the real signal for whether either
      // provider actually returned something.
      sentimentDataAvailable: socialResult?.has_data === true,
      macroDataAvailable: typeof macroEvidence?.regime === "string" && (macroEvidence.regime as string).toLowerCase() !== "unknown",
      // scoreInsider() always returns a non-null {score:50,...} shape on
      // failure/no-data too — `available` is the real signal.
      insiderDataAvailable: insiderAvailable,
    },
  };

  // Phase 1: write evidence records (fire-and-forget, never blocks scoring)
  void writeBatchEvidence(supabase, [
    {
      symbol,
      evidence_type: "fundamental",
      source: "alpha_vantage",
      payload: fundEvidence,
      quality_state: result.dataQuality.fundamentalDataAvailable ? "ok" : "missing",
    },
    {
      symbol,
      evidence_type: "ohlcv",
      source: "alpha_vantage",
      payload: { data_points: candles.length, latest_date: candles[candles.length - 1]?.date },
      quality_state: candles.length >= 50 ? "ok" : candles.length >= 14 ? "ok" : "missing",
    },
    ...(socialResult ? [{
      symbol,
      evidence_type: "sentiment" as const,
      source: "stocktwits" as const,
      payload: socialResult,
      quality_state: "ok" as const,
    }] : []),
    ...(insiderResult ? [{
      symbol,
      evidence_type: "insider" as const,
      source: "alpha_vantage" as const,
      payload: insiderResult,
      quality_state: "ok" as const,
    }] : []),
    {
      symbol: undefined,
      evidence_type: "macro",
      source: "macro_sentinel",
      payload: macroEvidence,
      quality_state: result.dataQuality.macroDataAvailable ? "ok" : "missing",
    },
  ]);

  return result;
}
