// Market-breadth shadow (owner-requested 2026-09-22, S5FI-style): % of a
// constituent universe trading above its own 50-session SMA, for US and
// India. Measure-only -- writes ONLY to exogenous_observations (scope=
// 'domestic'), which has no score/sizing/exit/order consumer (see that
// table's own comment). This is a regime/context gauge, not a stock picker:
// breadth tells you whether participation is broad or thin, never which name
// to buy -- see the architecture note in this conversation for why it isn't
// wired into scoring.
//
// US universe: the curated large-cap sample already maintained in
// lib/portfolio-risk.ts's SECTOR_MAP (~130 real single-stock symbols across
// GICS-like sectors, ETF/fund rows excluded) -- NOT the official S&P 500
// constituent list, which this repo does not maintain anywhere. Labelled
// honestly as a sample, not claimed as the index.
// India universe: the existing NIFTY50_UNIVERSE (real, versioned index
// membership) already used for India's advance/decline breadth block.
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchUsCandles } from "@/lib/data/candles";
import { fetchYahooCandles } from "@/lib/data/yahoo-candles";
import type { Candle } from "@/lib/data/technicals";
import { SECTOR_MAP } from "@/lib/portfolio-risk";
import { NIFTY50_UNIVERSE } from "@/lib/india-markets/constituents";
import { computeBreadthAboveSma50 } from "@/lib/trading/breadth-features";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_AV_FALLBACK = async () => [];
const NON_STOCK_SECTORS = new Set(["Diversified Equity", "International Equity", "Fixed Income", "Commodities", "Digital Assets"]);
const US_BREADTH_UNIVERSE = Object.entries(SECTOR_MAP)
  .filter(([, sector]) => !NON_STOCK_SECTORS.has(sector))
  .map(([symbol]) => symbol);

// Min coverage before the recorded percentage is trusted -- mirrors
// BREADTH_COVERAGE_FLOOR's role for India's existing advance/decline breadth.
const MIN_COVERAGE_PCT = 70;

function fingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function collectMarket(market: "us" | "india", universe: string[], supabase: ReturnType<typeof createServiceClient>) {
  const perSymbol = new Map<string, Candle[]>();
  await Promise.all(universe.map(async (symbol) => {
    const candles = market === "us"
      ? (await fetchUsCandles(symbol, NO_AV_FALLBACK).catch(() => ({ candles: [] as Candle[] }))).candles
      : await fetchYahooCandles(symbol, "6mo").catch(() => [] as Candle[]);
    if (candles.length > 0) perSymbol.set(symbol, candles);
  }));

  const breadth = computeBreadthAboveSma50(perSymbol);
  const now = new Date();
  const seriesKey = market === "us" ? "us_largecap_sample.pct_above_sma50" : "nifty50.pct_above_sma50";
  const payload = { market, universeSize: breadth.universeSize, eligible: breadth.eligible, resolved: breadth.resolved };
  const row = {
    market, scope: "domestic", series_key: seriesKey,
    value: breadth.pctAboveSma50, unit: "pct",
    observed_period: now.toISOString().slice(0, 10),
    published_at: now.toISOString(), available_at: now.toISOString(),
    source: market === "us" ? "yahoo+massive+eodhd+twelvedata" : "yahoo",
    source_url: market === "us" ? "https://query1.finance.yahoo.com/v8/finance/chart/" : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(universe[0] ?? "")}`,
    source_revision: `coverage=${breadth.coveragePct.toFixed(1)}pct;universe=${universe.length}`,
    payload_fingerprint: fingerprint(payload),
    quality: breadth.pctAboveSma50 == null ? "unavailable" as const
      : breadth.coveragePct < MIN_COVERAGE_PCT ? "partial" as const : "fresh" as const,
  };
  const { error } = await supabase.from("exogenous_observations").insert(row);
  if (error?.code === "23505") return { market, status: "already_recorded" as const };
  if (error) throw new Error(error.message);
  return { market, status: "recorded" as const, pctAboveSma50: breadth.pctAboveSma50, coveragePct: breadth.coveragePct, eligible: breadth.eligible, universeSize: breadth.universeSize };
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = createServiceClient();
  const results: Array<{ market: string; status: string; error?: string }> = [];
  for (const [market, universe] of [["us", US_BREADTH_UNIVERSE], ["india", NIFTY50_UNIVERSE.symbols]] as const) {
    try {
      results.push(await collectMarket(market, universe, supabase));
    } catch (err: any) {
      const message = err?.message ?? String(err);
      console.error(`[market-breadth-collect] ${market}: ${message}`);
      results.push({ market, status: "error", error: message });
    }
  }
  return NextResponse.json({ status: "ran", now: new Date().toISOString(), results });
}
