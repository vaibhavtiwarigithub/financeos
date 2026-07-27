/**
 * Deterministic Score Computation — Phase 0
 * All 5 sub-scores derived from real fetched data. No LLM number generation.
 * LLM only receives computed scores + evidence to write thesis and direction.
 */

import { computeTechnicals, scoreTechnicals } from "./technicals";
import type { DeterministicQuote } from "./quotes";
import { writeEvidence, writeBatchEvidence, type SourceName } from "./evidence";
import { isIndia } from "@/lib/india-data";

export type MarketScope = "us" | "india";

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

// Rough sector median P/E — used to score valuation RELATIVE to sector rather
// than one absolute band (a P/E of 30 is cheap for software, rich for a
// utility). Deliberately coarse priors; the IC-gated path can refine per market
// once there's enough data. Unknown sector falls back to 20 ≈ the prior
// absolute behavior, so this is near-backward-compatible for unclassified names.
const SECTOR_PE_NORM: Record<string, number> = {
  "technology": 30, "communication services": 20,
  "health care": 25, "healthcare": 25,
  "consumer discretionary": 24, "consumer cyclical": 24,
  "consumer staples": 22, "consumer defensive": 22,
  "industrials": 20, "materials": 16, "basic materials": 16,
  "energy": 12, "financials": 14, "financial services": 14,
  "utilities": 18, "real estate": 30,
};
function sectorPeNorm(sector: string | undefined): number {
  if (!sector) return 20;
  return SECTOR_PE_NORM[sector.trim().toLowerCase()] ?? 20;
}

export function scoreFundamentals(overview: Record<string, string>, isEtf: boolean, currentPrice?: number): { score: number; evidence: Record<string, unknown> } {
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
    // Sector-relative valuation: P/E vs the sector's normal P/E, not one
    // absolute band. ratio < 0.7 (cheap vs sector) → +18; > 2.0 (rich) → -22.
    // Unknown sector → norm 20, which recovers roughly the prior absolute bands.
    const norm = sectorPeNorm(overview.Sector);
    const ratio = pe / norm;
    evidence.pe_sector_norm = norm;
    evidence.pe_vs_sector_ratio = parseFloat(ratio.toFixed(2));
    if (ratio < 0.7) score += 18;
    else if (ratio < 1.0) score += 8;
    else if (ratio < 1.4) score -= 3;
    else if (ratio < 2.0) score -= 12;
    else score -= 22;
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

  // Revenue acceleration from RH get_financials (QoQ growth rate delta).
  // Positive = growth rate improving → bullish; negative = decelerating → bearish.
  const revenueAccel = parseFloat(overview.RevenueAcceleration ?? "");
  if (!isNaN(revenueAccel)) {
    evidence.revenue_acceleration = revenueAccel;
    if (revenueAccel > 0.05) score += 12;
    else if (revenueAccel > 0) score += 5;
    else if (revenueAccel < -0.05) score -= 12;
    else score -= 5;
  }

  // Margin trend from RH get_financials (net margin delta last 2 quarters).
  const marginTrend = parseFloat(overview.MarginTrend ?? "");
  if (!isNaN(marginTrend)) {
    evidence.margin_trend = marginTrend;
    if (marginTrend > 0.02) score += 8;
    else if (marginTrend > 0) score += 3;
    else if (marginTrend < -0.02) score -= 8;
    else score -= 3;
  }

  // Analyst target vs current price — a real forward signal (previously logged
  // as evidence but never scored). Upside = (target - price)/price. Uses the
  // live close when available, else the 200-day MA as a price proxy.
  const target = parseFloat(overview.AnalystTargetPrice ?? "");
  const refPrice = (currentPrice && currentPrice > 0)
    ? currentPrice
    : parseFloat(overview["200DayMovingAverage"] ?? "");
  if (!isNaN(target) && target > 0 && !isNaN(refPrice) && refPrice > 0) {
    const upside = (target - refPrice) / refPrice;
    evidence.analyst_target = target;
    evidence.analyst_upside_pct = parseFloat((upside * 100).toFixed(1));
    evidence.analyst_target_mode = "observational_only";
  }

  evidence.symbol = overview.Symbol;
  evidence.sector = overview.Sector;
  evidence.industry = overview.Industry;

  return { score: Math.max(0, Math.min(100, Math.round(score))), evidence };
}

// ── Sentiment scoring (normalize existing fetchSocialSentiment output) ─────────

export function scoreSentiment(socialResult: any): { score: number; evidence: Record<string, unknown> } {
  // Pseudo-count prior for Bayesian shrinkage toward neutral (0.5): the score is
  // pulled to 50 when message volume is thin, so 1 bullish message no longer
  // scores 100 like 500 messages at 90% bullish. K ≈ "10 messages worth" of a
  // neutral prior. TODO: tune SENTIMENT_PRIOR_STRENGTH once real sentiment/outcome
  // data exists to calibrate how fast thin sentiment should earn full weight.
  const SENTIMENT_PRIOR_STRENGTH = 10;

  if (!socialResult) return { score: 50, evidence: { note: "no sentiment data" } };

  // fetchSocialSentiment returns a source-shrunk direct score. Legacy callers
  // without one continue through the fallback shrinkage below.
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
    // bull/bear are directional percentages (0-100). Take the raw bullish share of
    // the two, then apply Bayesian shrinkage toward 0.5 by actual message volume so
    // thin/noisy sentiment doesn't get full weight. shrunk = (frac*N + 0.5*K)/(N+K):
    // yields 0.5 at N=0 and approaches the raw fraction as message count grows.
    // (Equivalent to the count form (bull+0.5K)/(total+K) with bull = frac*N.)
    const directional = bull + bear;
    if (directional <= 0) {
      return { score: 50, evidence: { bullish_pct: bull, bearish_pct: bear, note: "no directional sentiment" } };
    }
    const bullFraction = bull / directional;
    const msgCount = socialResult.stocktwits_sample_size ?? socialResult.stocktwits_message_count ?? 0;
    const shrunkFraction =
      (bullFraction * msgCount + 0.5 * SENTIMENT_PRIOR_STRENGTH) / (msgCount + SENTIMENT_PRIOR_STRENGTH);
    const score = Math.round(shrunkFraction * 100);
    return {
      score: Math.max(0, Math.min(100, score)),
      evidence: { bullish_pct: bull, bearish_pct: bear, message_count: msgCount, prior_strength: SENTIMENT_PRIOR_STRENGTH },
    };
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

// Maximum age of a macro_regime row that may still score a symbol.
//
// JUSTIFICATION: macro_regime is WEEKLY — `week_of` is a Monday and the
// `kairos-macro-sentinel` cron runs `30 12 * * 1` (Mondays 12:30 UTC). So the
// freshest legitimate row is 0 days old right after the cron and reaches
// exactly 7 days old on the following Monday just BEFORE the next run fires.
// A bound of 7 would therefore reject a perfectly valid current verdict during
// that Monday-morning window, so the bound must exceed 7. We allow 3 further
// days of operational slack (a late/retried cron, a deploy-day skip) → 10.
//
// The bound is deliberately BELOW 14: at 14+ days a full weekly run has been
// missed, and riding the prior week's verdict would silently present a
// fortnight-old macro read as current. That is the exact prod bug this bound
// exists to kill — on 2026-07-13 the selector reached back to the 2026-06-30
// `green` row (13 days) because 07-06 was `unknown`, and scored 13 India rows
// at macro_score 100 (maximally calm) off a fortnight-stale verdict.
//
// FAIL-SAFE: when no row satisfies the bound, macro is UNAVAILABLE (excluded,
// weights renormalize onto the remaining dimensions). It NEVER falls back to a
// calm/green default and NEVER reaches further back.
//
// PRECEDENT: app/api/agents/downside-hedge/route.ts independently rejects its
// own macro read at `macroAge > 10 * 86_400_000` — the same 10-day bound,
// chosen separately for the same weekly table. This keeps the two money-path
// consumers of macro_regime consistent about what "too old to act on" means.
export const MAX_MACRO_AGE_DAYS = 10;

// Minimum real indicators behind a macro verdict before it may score anything.
//
// This mirrors MacroSentinel's OWN classification floor: computeRegime()
// (app/api/agents/macro-sentinel/route.ts) returns regime "unknown" with a null
// danger_score when fewer than 3 of its 8 FRED indicators came back, because
// "<3 indicators is NOT evidence of a healthy economy".
//
// On `signals_triggered = 0` being suspect (asked explicitly): NO — it must not
// be. A genuinely calm week legitimately trips zero signals, so treating
// signals_triggered=0 as suspect would discard real `green` verdicts and bias
// the book bearish. The honest discriminator is the INDICATOR COUNT, not the
// signal count — and prod proves it. The 2026-06-30 `green` row has
// danger_score 0, signals_triggered 0 AND `raw_indicators = []` (ZERO
// indicators fetched), with the summary "No recession signals. Economy in
// expansion." That row predates the unknown-guard above, so it is not merely
// "indistinguishable from a failed run" — it IS a failed run fossilized as a
// calm verdict. (The 2026-06-29 `red`/danger-100 row is the same class of
// fossil: 1 indicator.) Checking `raw_indicators` length >= 3 rejects those
// legacy rows on their own evidence, and would still reject a fossil written
// THIS week, which the age bound alone cannot catch.
const MIN_MACRO_INDICATORS = 3;

function macroRowAgeDays(weekOf: unknown, now: Date): number {
  if (typeof weekOf !== "string") return Infinity; // unverifiable age → fail closed
  const t = Date.parse(`${weekOf}T00:00:00Z`);
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 86_400_000;
}

// Number of real indicators behind the verdict. `raw_indicators` is a jsonb
// ARRAY of indicator objects. A non-array (null/absent) means we cannot prove
// the run had evidence → fail closed rather than assume it did.
function macroIndicatorCount(rawIndicators: unknown): number {
  return Array.isArray(rawIndicators) ? rawIndicators.length : -1;
}

export interface MacroResult {
  score: number;
  evidence: Record<string, unknown>;
  available: boolean;
}

async function fetchMacroScore(supabase: any, market: MarketScope, now: Date): Promise<MacroResult> {
  // India has NO macro regime — and must not borrow the US one.
  //
  // MacroSentinel is US-only BY CONSTRUCTION: all 8 indicators are US FRED
  // series (yield curve, Sahm rule, US GDP, nonfarm payrolls, US CPI, US retail
  // sales, fed funds, US durables). `macro_regime` carries NO `market` column,
  // so reading it for an India symbol stamps the US Fed's verdict onto Indian
  // equities — a direct violation of the per-market/per-currency rule, on the
  // money path (macro_score is a genome dimension → weighted analyst score →
  // direction gate → paper buys).
  //
  // The honest answer is UNAVAILABLE: the availability mask excludes macro and
  // renormalizes the weights onto the remaining dimensions. We deliberately do
  // NOT invent an India regime, and do NOT score it a fake-neutral 50 that
  // still counts as evidence. lib/india-macro.ts (NSE FII/DII flows) exists and
  // is consumed by research-agent.ts as thesis EVIDENCE — wiring it into
  // macro_score is a separate approved build, NOT this fix.
  if (market === "india") {
    return {
      score: 50,
      evidence: {
        market: "india",
        source: "none",
        note:
          "No India macro regime exists. MacroSentinel is US-only (8 US FRED series) and macro_regime has no market tag, " +
          "so its verdict cannot score Indian equities. Macro dimension UNAVAILABLE — excluded from the weighted score " +
          "and its weight renormalized onto the remaining dimensions.",
      },
      available: false,
    };
  }

  try {
    // Fetch the 3 most recent rows so we can fall back to the last KNOWN regime
    // if the newest run produced "unknown" (e.g. MacroSentinel fetched too few
    // indicators to classify). Using only the newest row meant that a single
    // failed MacroSentinel run would lock macro out of scoring for the entire
    // following week despite a valid regime being available one row back.
    // That fallback is now AGE-BOUNDED (see MAX_MACRO_AGE_DAYS): it may cover a
    // single failed run within the bound, never an arbitrarily old verdict.
    const { data: rows } = await supabase
      .from("macro_regime")
      .select("danger_score, regime, week_of, signals_triggered, raw_indicators")
      .order("week_of", { ascending: false })
      .limit(3);

    const allRows: any[] = Array.isArray(rows) ? rows : rows ? [rows] : [];
    if (!allRows.length) return { score: 50, evidence: { note: "no macro data" }, available: false };

    // A row may score only if ALL hold:
    //  1. MacroSentinel actually reached a verdict (regime != "unknown"): an
    //     "unknown" row's danger_score is a placeholder 0, NOT a calm read.
    //  2. It is within MAX_MACRO_AGE_DAYS (no unbounded reach-back).
    //  3. It rests on >= MIN_MACRO_INDICATORS real indicators (rejects the
    //     legacy fossil rows written before the unknown-guard existed).
    const rejected: Record<string, unknown>[] = [];
    let chosen: any = null;
    for (const r of allRows) {
      if (!r) continue;
      const regime = String(r.regime ?? "").toLowerCase();
      const ageDays = macroRowAgeDays(r.week_of, now);
      const indicators = macroIndicatorCount(r.raw_indicators);
      let reason: string | null = null;
      if (regime === "unknown" || regime === "") reason = "no verdict (regime unknown)";
      else if (ageDays > MAX_MACRO_AGE_DAYS) reason = `stale: ${Math.floor(ageDays)}d old > ${MAX_MACRO_AGE_DAYS}d bound`;
      else if (indicators < MIN_MACRO_INDICATORS) {
        reason = `only ${indicators < 0 ? "unverifiable" : indicators} indicator(s) < ${MIN_MACRO_INDICATORS} — failed run, not a real verdict`;
      }
      if (reason) {
        rejected.push({ week_of: r.week_of, regime: r.regime, reason });
        continue;
      }
      chosen = { ...r, ageDays, indicators };
      break;
    }

    // FAIL-SAFE: nothing recent and trustworthy → macro is UNAVAILABLE. Never
    // reach further back, never default to green/calm.
    if (!chosen) {
      return {
        score: 50,
        evidence: {
          source: "macro_sentinel",
          note:
            `No macro verdict within the ${MAX_MACRO_AGE_DAYS}-day bound — macro UNAVAILABLE (excluded from scoring). ` +
            `Not defaulted to calm: an absent verdict is not a benign one.`,
          rejected_rows: rejected,
        },
        available: false,
      };
    }

    const dangerScore = chosen.danger_score ?? 50;
    // Convert danger score (0-100 where 100 = most dangerous) to macro_score (0-100 where 100 = bullish)
    const macroScore = Math.round(100 - dangerScore);

    return {
      score: Math.max(0, Math.min(100, macroScore)),
      evidence: {
        danger_score: dangerScore,
        regime: chosen.regime,
        source: "macro_sentinel",
        market: "us",
        as_of: chosen.week_of,
        age_days: Math.floor(chosen.ageDays),
        indicators_available: chosen.indicators,
        ...(rejected.length ? { skipped_rows: rejected } : {}),
      },
      available: true,
    };
  } catch {
    return { score: 50, evidence: { note: "macro query failed" }, available: false };
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
  /**
   * Market this symbol trades in. Decides whether the (US-only) MacroSentinel
   * regime may score it at all. Defaults to deriving from the symbol via
   * isIndia() — the SAME classifier research-agent.ts uses — so an India symbol
   * can never silently inherit the US macro regime just because a caller forgot
   * to pass it.
   */
  market?: MarketScope;
  /** Injectable clock for deterministic tests of the macro age bound. */
  now?: Date;
  provenance?: Partial<Record<"fundamental" | "technical" | "sentiment" | "insider", SourceName>>;
}): Promise<ComputedScores> {
  const { symbol, isEtf, avOverview, candles, socialResult, insiderResult, supabase } = opts;
  const market: MarketScope = opts.market ?? (isIndia(symbol) ? "india" : "us");
  const now = opts.now ?? new Date();

  // Compute all scores deterministically
  const latestClose = candles.length > 0 ? candles[candles.length - 1].close : undefined;
  const { score: fundamental_score, evidence: fundEvidence } = scoreFundamentals(avOverview, isEtf, latestClose);

  const technicals = computeTechnicals(candles);
  const technical_score = scoreTechnicals(technicals);
  const techEvidence = { ...technicals, dataPoints: candles.length };

  const { score: sentiment_score, evidence: sentEvidence } = scoreSentiment(socialResult);

  const { score: macro_score, evidence: macroEvidence, available: macroAvailable } =
    await fetchMacroScore(supabase, market, now);

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
      // fetchMacroScore now reports availability EXPLICITLY rather than having
      // the caller re-derive it from the evidence blob. The old inference
      // (`regime` is a string and != "unknown") could only ever express the
      // unknown-regime case: an India symbol, a stale row, or a zero-indicator
      // fossil all still carry a plausible-looking `regime` string and would
      // have been (mis)read as available real evidence.
      macroDataAvailable: macroAvailable,
      // scoreInsider() always returns a non-null {score:50,...} shape on
      // failure/no-data too — `available` is the real signal.
      insiderDataAvailable: insiderAvailable,
    },
  };

  // Phase 1: write evidence records (fire-and-forget, never blocks scoring)
  void writeBatchEvidence(supabase, [
    // An ETF has no company-reported fundamentals. Its score correctly treats
    // the dimension as structurally inapplicable, so do not audit an empty
    // payload as a successful fundamental observation.
    ...(!isEtf ? [{
      symbol,
      evidence_type: "fundamental" as const,
      source: opts.provenance?.fundamental ?? "unavailable",
      payload: fundEvidence,
      quality_state: result.dataQuality.fundamentalDataAvailable ? "ok" as const : "missing" as const,
    }] : []),
    {
      symbol,
      evidence_type: "ohlcv",
      source: opts.provenance?.technical ?? "unavailable",
      payload: { data_points: candles.length, latest_date: candles[candles.length - 1]?.date },
      quality_state: candles.length >= 50 ? "ok" : candles.length >= 14 ? "ok" : "missing",
    },
    ...(socialResult ? [{
      symbol,
      evidence_type: "sentiment" as const,
      source: opts.provenance?.sentiment ?? "unavailable",
      payload: socialResult,
      quality_state: (result.dataQuality.sentimentDataAvailable ? "ok" : "missing") as "ok" | "missing",
    }] : []),
    ...(insiderResult ? [{
      symbol,
      evidence_type: "insider" as const,
      source: opts.provenance?.insider ?? "unavailable",
      payload: insiderResult,
      quality_state: (result.dataQuality.insiderDataAvailable ? "ok" : "missing") as "ok" | "missing",
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
