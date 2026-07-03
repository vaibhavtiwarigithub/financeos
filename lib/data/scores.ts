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

function scoreFundamentals(overview: Record<string, string>, isEtf: boolean): { score: number; evidence: Record<string, unknown> } {
  if (isEtf || !overview?.Symbol) {
    // ETFs: use simple momentum proxy (no PE/earnings)
    return { score: 55, evidence: { note: "ETF — fundamental scoring uses 55 neutral baseline" } };
  }

  let score = 50;
  const evidence: Record<string, unknown> = {};

  const pe = parseFloat(overview.PERatio ?? "");
  if (!isNaN(pe) && pe > 0) {
    evidence.pe_ratio = pe;
    if (pe < 15) score += 20;
    else if (pe < 25) score += 10;
    else if (pe > 40) score -= 15;
    else if (pe > 60) score -= 25;
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

  // Compute from bull/bear pct
  const bull = socialResult.bullish_pct ?? socialResult.bull_pct ?? null;
  const bear = socialResult.bearish_pct ?? socialResult.bear_pct ?? null;
  if (bull != null && bear != null) {
    const score = Math.round(bull * 100); // bull% mapped directly to 0-100
    return { score: Math.max(0, Math.min(100, score)), evidence: { bullish_pct: bull, bearish_pct: bear } };
  }

  return { score: 50, evidence: { note: "sentiment format unknown", raw: socialResult } };
}

// ── Macro scoring from macro_signals table (MacroSentinel) ────────────────────

async function fetchMacroScore(supabase: any): Promise<{ score: number; evidence: Record<string, unknown> }> {
  try {
    const { data } = await supabase
      .from("macro_signals")
      .select("danger_score, regime, created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!data) return { score: 50, evidence: { note: "no macro data" } };

    const dangerScore = data.danger_score ?? 50;
    const regime = data.regime ?? "UNKNOWN";

    // Convert danger score (0-100 where 100 = most dangerous) to macro_score (0-100 where 100 = bullish)
    const macroScore = Math.round(100 - dangerScore);

    return {
      score: Math.max(0, Math.min(100, macroScore)),
      evidence: { danger_score: dangerScore, regime, source: "macro_sentinel", as_of: data.created_at },
    };
  } catch {
    return { score: 50, evidence: { note: "macro query failed" } };
  }
}

// ── Insider scoring (reuse existing scoreInsider output) ──────────────────────

export function normalizeInsiderScore(insiderResult: any): { score: number; evidence: Record<string, unknown> } {
  if (!insiderResult) return { score: 50, evidence: { note: "no insider data" } };
  if (typeof insiderResult === "number") return { score: Math.max(0, Math.min(100, insiderResult)), evidence: {} };
  const score = insiderResult.score ?? insiderResult.insider_score ?? 50;
  return { score: Math.max(0, Math.min(100, Math.round(score))), evidence: insiderResult };
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

  const { score: insider_score, evidence: insiderEvidence } = normalizeInsiderScore(insiderResult);

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
      fundamentalDataAvailable: !!avOverview?.Symbol || isEtf,
      technicalDataPoints: candles.length,
      sentimentDataAvailable: !!socialResult,
      macroDataAvailable: !!macroEvidence?.regime,
      insiderDataAvailable: !!insiderResult,
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
