// Cheap, fail-soft volatility input for the Portfolio Constructor. 20-trading-day
// stdev of daily returns, as a fraction (e.g. 0.02 = 2%/day). Falls back to a
// sector-agnostic 2% default when candles are unavailable — the constructor
// treats that as "typical" volatility rather than blocking a trade over a data gap.
//
// W9 — the fallback used to be reachable only on an exception. The US branch read
// 21 `price_cache` closes with no staleness or coverage check and handed the
// result to PaperTrader position sizing. For the 101 symbols frozen at 2026-07-22
// that number was not merely stale, it was PERMANENTLY FIXED: the same Jun–Jul
// dispersion, forever, priced into every future trade as though it were current.
//
// It now fails to the default EXPLICITLY and OBSERVABLY. `estimateDailyVolPct`
// keeps its exact signature (PaperTrader is not touched); callers that want to
// know WHY they got 2% use `estimateDailyVolPctDetailed`. Every fallback logs its
// reason — a silent default on the sizing path is the thing that hid this.
//
// The India branch fetches Yahoo candles live per call; it was never affected.

import { fetchYahooCandles } from "@/lib/india-data";
import { assessSeries } from "@/lib/data/price-cache-freshness";

const DEFAULT_DAILY_VOL = 0.02;

/** Fewer than this many usable closes and the stdev is not the statistic asked for. */
const MIN_CLOSES = 15;

export type VolBasis = "measured" | "default";
export type VolReason = "ok" | "no_data" | "insufficient_coverage" | "stale_series" | "undispersed" | "error";

export interface DailyVolEstimate {
  vol: number;
  basis: VolBasis;
  reason: VolReason;
  /** Market date of the newest close the estimate is based on, when there was one. */
  asOf: string | null;
  bars: number;
}

function stdevOfReturns(closes: number[]): number | null {
  if (closes.length < 5) return null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  if (returns.length < 4) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

function fallback(symbol: string, reason: VolReason, asOf: string | null, bars: number): DailyVolEstimate {
  console.warn(
    `[portfolio-inputs] ${symbol}: daily-vol falling back to default ${DEFAULT_DAILY_VOL} — ${reason} (bars=${bars}, asOf=${asOf ?? "none"})`,
  );
  return { vol: DEFAULT_DAILY_VOL, basis: "default", reason, asOf, bars };
}

/**
 * Daily volatility WITH the provenance of how it was arrived at.
 *
 * A `basis: "default"` result means the constructor is sizing off an assumption,
 * not off this symbol's behaviour. That distinction is the whole point.
 */
export async function estimateDailyVolPctDetailed(
  symbol: string,
  market: "us" | "india",
  supabase: any,
): Promise<DailyVolEstimate> {
  try {
    if (market === "india") {
      const candles = await fetchYahooCandles(symbol, "1mo");
      const window = candles.slice(-21);
      const vol = stdevOfReturns(window.map((c) => c.close));
      if (vol == null) return fallback(symbol, "insufficient_coverage", window.at(-1)?.date ?? null, window.length);
      return { vol, basis: "measured", reason: "ok", asOf: window.at(-1)?.date ?? null, bars: window.length };
    }

    const { data } = await supabase
      .from("price_cache")
      .select("date, close")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(21);

    const rows = (data ?? []) as { date: string; close: any }[];
    // Coverage AND freshness. A frozen window is dense and useless; a short window
    // is fresh and useless. Neither may quietly become a sizing input.
    const series = assessSeries(rows, { symbol, market: "us", minBars: MIN_CLOSES });
    if (!series.ok) return fallback(symbol, series.reason as VolReason, series.asOf, series.bars);

    const closes = rows
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => parseFloat(r.close));
    const vol = stdevOfReturns(closes);
    if (vol == null) return fallback(symbol, "insufficient_coverage", series.asOf, series.bars);
    // A window of identical closes yields 0 — mathematically valid, but as a sizing
    // input it means "infinite size". Treat it as unmeasured.
    if (!(vol > 0)) return fallback(symbol, "undispersed", series.asOf, series.bars);

    return { vol, basis: "measured", reason: "ok", asOf: series.asOf, bars: series.bars };
  } catch (e: any) {
    return fallback(symbol, "error", null, 0);
  }
}

/** Backward-compatible bare number. PaperTrader calls this; do not change the shape. */
export async function estimateDailyVolPct(symbol: string, market: "us" | "india", supabase: any): Promise<number> {
  return (await estimateDailyVolPctDetailed(symbol, market, supabase)).vol;
}
