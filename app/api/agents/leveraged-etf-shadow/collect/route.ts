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
import { completedSessionCandles } from "@/lib/data/completed-candles";
import { getLeveragedExecutableQuotes, getLeveragedIntradayQuote, type LeveragedQuoteSymbol } from "@/lib/data/leveraged-intraday-quotes";
import type { DeterministicQuote } from "@/lib/data/quotes";
import { computeLeveragedPathFeatures, computeLeveragedShadowFeatures, correlation20d } from "@/lib/trading/leveraged-etf-shadow-features";
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

async function collectOne(
  symbol: LeveragedShadowSymbol, now: string, supabase: ReturnType<typeof createServiceClient>,
  readQuote: (symbol: LeveragedQuoteSymbol) => Promise<DeterministicQuote>,
  brokerQuotes: Map<LeveragedQuoteSymbol, DeterministicQuote>,
) {
  const underlying = LEVERAGED_SHADOW_UNIVERSE[symbol].underlyingSymbol;
  const peer = PEER[symbol];
  const [etf, und, quote, underlyingQuote, peerEtf] = await Promise.all([
    fetchUsCandles(symbol, NO_AV_FALLBACK).catch(() => ({ candles: [] as Candle[], source: "unavailable" })),
    fetchUsCandles(underlying, NO_AV_FALLBACK).catch(() => ({ candles: [] as Candle[], source: "unavailable" })),
    readQuote(symbol),
    readQuote(underlying),
    peer ? fetchUsCandles(peer, NO_AV_FALLBACK).catch(() => ({ candles: [] as Candle[], source: "unavailable" })) : Promise.resolve(null),
  ]);
  const brokerQuote = brokerQuotes.get(symbol);
  // The decision timestamp follows every source read. Capturing it at route
  // start would make a legitimate venue event appear to come from the future.
  const observedAt = new Date().toISOString();
  if (!isLeveragedObservationWindow(observedAt)) throw new Error("observation_window_elapsed_during_collection");
  const etfBars = completedSessionCandles(etf.candles, "us", new Date(now));
  const underlyingBars = completedSessionCandles(und.candles, "us", new Date(now));
  const etfFeatures = computeLeveragedShadowFeatures(etfBars);
  const undFeatures = computeLeveragedShadowFeatures(underlyingBars);
  const pathFeatures = computeLeveragedPathFeatures(etfBars, underlyingBars, LEVERAGED_SHADOW_UNIVERSE[symbol].direction);
  const correlationToPeer20d = peerEtf ? correlation20d(etfBars, completedSessionCandles(peerEtf.candles, "us", new Date(now))) : null;

  const observation = buildLeveragedEtfShadowObservation({
    observedAt,
    symbol,
    etfPrice: brokerQuote?.price ?? (quote.source === "unavailable" ? null : quote.price),
    underlyingPrice: underlyingQuote.source === "unavailable" ? null : underlyingQuote.price,
    bid: brokerQuote?.bid ?? null,
    ask: brokerQuote?.ask ?? null,
    // A fetch time is not a market observation time. EOD cache and day-cached AV
    // cannot satisfy an intraday quote contract even when fetched just now.
    quoteAsOf: brokerQuote?.observedAt ?? quote.observedAt ?? null,
    underlyingQuoteAsOf: underlyingQuote.observedAt ?? null,
    realizedVol20dPct: etfFeatures.realizedVol20dPct,
    atr14Pct: etfFeatures.atr14Pct,
    trend20dPct: etfFeatures.trend20dPct,
    underlyingTrend20dPct: undFeatures.trend20dPct,
    directionalUnderlyingTrend20dPct: undFeatures.trend20dPct == null ? null : undFeatures.trend20dPct * (LEVERAGED_SHADOW_UNIVERSE[symbol].direction === "inverse" ? -1 : 1),
    underlyingRealizedVol20dPct: undFeatures.realizedVol20dPct,
    proxyTrackingRms20dPct: pathFeatures.proxyTrackingRms20dPct,
    maxAbsOvernightGap20dPct: pathFeatures.maxAbsOvernightGap20dPct,
    dollarVolume: etfFeatures.dollarVolume,
    correlationToPeer20d,
  });

  const { error } = await supabase.from("leveraged_etf_shadow_observations").insert({
    market: "us", market_session: observation.marketSession, observed_at: observation.observedAt,
    symbol: observation.symbol, underlying_symbol: observation.underlyingSymbol, policy_version: observation.policyVersion,
    observation_window: observation.window, measurement_status: observation.measurementStatus, missing: observation.missing,
    features: observation.features,
    quote: { ...observation.quote, etf_source: brokerQuote?.source ?? quote.source,
      bid_ask_source: brokerQuote ? "robinhood_mcp" : null, underlying_source: underlyingQuote.source },
    decision: observation.decision,
  });
  if (error?.code === "23505") return { symbol, status: "already_recorded" as const };
  if (error) throw new Error(`${symbol}: ${error.message}`);
  return { symbol, status: "recorded" as const, measurementStatus: observation.measurementStatus, missing: observation.missing };
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = new Date().toISOString();
  const supabase = createServiceClient();
  // The four funds share two underlyings. Reuse each provider response within
  // this run so the shadow spends six quote credits, not eight.
  const quotes = new Map<LeveragedQuoteSymbol, Promise<DeterministicQuote>>();
  const readQuote = (symbol: LeveragedQuoteSymbol) => {
    let quote = quotes.get(symbol);
    if (!quote) {
      quote = getLeveragedIntradayQuote(symbol);
      quotes.set(symbol, quote);
    }
    return quote;
  };

  if (!isLeveragedObservationWindow(now)) {
    return NextResponse.json({ status: "outside_window", now, note: "cron fired outside the 11:00-11:14 ET window (DST drift or off-schedule trigger); no observation recorded" });
  }

  const brokerQuotes = await getLeveragedExecutableQuotes(Object.keys(LEVERAGED_SHADOW_UNIVERSE) as LeveragedQuoteSymbol[]);

  const results: Array<{ symbol: string; status: string; error?: string }> = [];
  for (const symbol of Object.keys(LEVERAGED_SHADOW_UNIVERSE) as LeveragedShadowSymbol[]) {
    try {
      results.push(await collectOne(symbol, now, supabase, readQuote, brokerQuotes));
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

  const incomplete = results.filter(r => r.status === "recorded" && "measurementStatus" in r && r.measurementStatus !== "complete");
  if (incomplete.length > 0) {
    await reportIssue({
      issueKey: "leveraged-etf-shadow-inputs-incomplete",
      severity: "warn",
      category: "data_collection",
      title: "Leveraged-ETF intraday shadow lacks verified inputs",
      detail: JSON.stringify(incomplete.map(r => ({ symbol: r.symbol, missing: "missing" in r ? r.missing : [] }))),
    }, supabase);
  } else if (results.length === Object.keys(LEVERAGED_SHADOW_UNIVERSE).length && results.every(r => r.status === "recorded" && "measurementStatus" in r && r.measurementStatus === "complete")) {
    await resolveIssue("leveraged-etf-shadow-inputs-incomplete", supabase);
  }

  return NextResponse.json({ status: "ran", now, results });
}

// pg_cron (kairos_call_agent) always POSTs. Vercel Hobby cron fires at an unspecified minute inside the hour, so the
// 11:00-11:14 ET window was never hit and leveraged_etf_shadow_observations stayed empty; the minute-precise pg_cron
// job `kairos-leveraged-etf-shadow` (15,16 UTC at :03) now drives it.
export const POST = GET;
