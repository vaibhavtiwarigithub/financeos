// Leveraged-ETF L1 shadow collector. The 11:00-11:14 ET observation window is
// enforced independently inside buildLeveragedEtfShadowObservation using the
// real ET clock (etParts), not the cron's UTC firing time — so a fixed-UTC
// cron slot that drifts out of the window correctly no-ops (logged, not
// silent) rather than recording a mistimed observation. See
// leveraged-etf-shadow.ts.
//
// 2026-09-22: vercel.json now schedules this path TWICE — 15:05 UTC
// (11:05 EDT) for April-October, 16:05 UTC (11:05 EST) for December-
// February — instead of the single fixed-UTC slot that went dark for ~4
// months outside EDT. KNOWN REMAINING GAP: March and November (the actual
// DST-transition months) are covered by neither slot precisely, since the
// US switch date (2nd Sunday March / 1st Sunday November) isn't expressible
// in cron's month field. Collection may miss a few days around each
// transition; it will not silently mis-time an observation (the window
// check still fails closed), it will just skip those days. Acceptable for
// a measure-only shadow; revisit if a full year of clean daily coverage
// becomes load-bearing for Phase 1 evidence review.
//
// Measure-only: this route writes ONLY to leveraged_etf_shadow_observations.
// It never reads or writes paper_positions, paper_trades, trade_proposals,
// or any order table, and calls no LLM.
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchUsCandles } from "@/lib/data/candles";
import { getQuote } from "@/lib/data/quotes";
import { computeLeveragedShadowFeatures, correlation20d } from "@/lib/trading/leveraged-etf-shadow-features";
import {
  buildLeveragedEtfShadowObservation,
  isLeveragedObservationWindow,
  LEVERAGED_SHADOW_UNIVERSE,
  type LeveragedShadowSymbol,
} from "@/lib/trading/leveraged-etf-shadow";
import type { Candle } from "@/lib/data/technicals";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// AV is the scarce 25/day-budget last resort used elsewhere for candles. This
// shadow is measure-only and SOXL/TQQQ/SOXX/QQQ are liquid enough that
// Yahoo/Massive/EODHD/Twelve Data already cover them — spending AV budget
// here would compete with money-path research for no benefit.
const NO_AV_FALLBACK = async () => [];

// SOXL<->TQQQ peer correlation (owner asked to "understand the relationship
// between these"). Only these two have a defined peer; SQQQ/SOXS are shadow
// entries with no peer computed.
const PEER: Partial<Record<LeveragedShadowSymbol, LeveragedShadowSymbol>> = { SOXL: "TQQQ", TQQQ: "SOXL" };

async function collectOne(symbol: LeveragedShadowSymbol, now: string, supabase: ReturnType<typeof createServiceClient>) {
  const underlying = LEVERAGED_SHADOW_UNIVERSE[symbol].underlyingSymbol;
  const peer = PEER[symbol];
  const [etf, und, quote, underlyingQuote, peerEtf] = await Promise.all([
    fetchUsCandles(symbol, NO_AV_FALLBACK).catch(() => ({ candles: [] as Candle[], source: "unavailable" })),
    fetchUsCandles(underlying, NO_AV_FALLBACK).catch(() => ({ candles: [] as Candle[], source: "unavailable" })),
    getQuote(symbol, supabase),
    getQuote(underlying, supabase),
    peer ? fetchUsCandles(peer, NO_AV_FALLBACK).catch(() => ({ candles: [] as Candle[], source: "unavailable" })) : Promise.resolve(null),
  ]);
  const etfFeatures = computeLeveragedShadowFeatures(etf.candles);
  const undFeatures = computeLeveragedShadowFeatures(und.candles);
  const correlationToPeer20d = peerEtf ? correlation20d(etf.candles, peerEtf.candles) : null;

  const observation = buildLeveragedEtfShadowObservation({
    observedAt: now,
    symbol,
    etfPrice: quote.source === "unavailable" ? null : quote.price,
    underlyingPrice: underlyingQuote.source === "unavailable" ? null : underlyingQuote.price,
    bid: quote.bid,
    ask: quote.ask,
    quoteAsOf: quote.source === "unavailable" ? null : quote.retrievedAt,
    underlyingQuoteAsOf: underlyingQuote.source === "unavailable" ? null : underlyingQuote.retrievedAt,
    realizedVol20dPct: etfFeatures.realizedVol20dPct,
    atr14Pct: etfFeatures.atr14Pct,
    trend20dPct: etfFeatures.trend20dPct,
    underlyingTrend20dPct: undFeatures.trend20dPct,
    dollarVolume: etfFeatures.dollarVolume,
    correlationToPeer20d,
  });

  const { error } = await supabase.from("leveraged_etf_shadow_observations").insert({
    market: "us", market_session: observation.marketSession, observed_at: observation.observedAt,
    symbol: observation.symbol, underlying_symbol: observation.underlyingSymbol, policy_version: observation.policyVersion,
    observation_window: observation.window, measurement_status: observation.measurementStatus, missing: observation.missing,
    features: observation.features, quote: observation.quote, decision: observation.decision,
  });
  if (error?.code === "23505") return { symbol, status: "already_recorded" as const };
  if (error) throw new Error(`${symbol}: ${error.message}`);
  return { symbol, status: "recorded" as const, measurementStatus: observation.measurementStatus, missing: observation.missing };
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = new Date().toISOString();
  const supabase = createServiceClient();

  if (!isLeveragedObservationWindow(now)) {
    return NextResponse.json({ status: "outside_window", now, note: "cron fired outside the 11:00-11:14 ET window (DST drift or off-schedule trigger); no observation recorded" });
  }

  const results: Array<{ symbol: string; status: string; error?: string }> = [];
  for (const symbol of Object.keys(LEVERAGED_SHADOW_UNIVERSE) as LeveragedShadowSymbol[]) {
    try {
      results.push(await collectOne(symbol, now, supabase));
    } catch (err: any) {
      const message = err?.message ?? String(err);
      console.error(`[leveraged-etf-shadow-collect] ${symbol}: ${message}`);
      results.push({ symbol, status: "error", error: message });
    }
  }

  const failed = results.filter(r => r.status === "error");
  if (failed.length > 0) {
    await reportIssue({
      issueKey: "leveraged-etf-shadow-collect-failed",
      severity: "warn",
      category: "data_collection",
      title: "Leveraged-ETF L1 shadow collector had failing symbols",
      detail: JSON.stringify(failed),
    }, supabase);
  } else {
    await resolveIssue("leveraged-etf-shadow-collect-failed", supabase);
  }

  return NextResponse.json({ status: "ran", now, results });
}
