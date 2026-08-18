// W5 — benchmark observations must carry their own market session.
//
// Defect. `paper-trade/route.ts` and `position-monitor/route.ts` both took a
// benchmark *quote* and accepted any positive number, ignoring `stale`, the
// source, and the session the price actually belongs to. The writer then
// stamped it `source_status='ok'` under whatever date the cron happened to run.
// Production proof: `bench_nav` 708.42 is VOO's 2026-08-11 close and it is
// stored under BOTH 2026-08-12 and 2026-08-13. Every relative-performance
// number computed off that series joined a portfolio close to a benchmark close
// from a different day.
//
// Rule. A benchmark observation is a DAILY BAR, not a quote. It carries the
// bar's own date and the provider that produced it, and it may only be written
// against a portfolio row for the SAME session. The observation date is never
// inferred from the run date. When the newest bar is not today's session, we
// write no benchmark for today and say why — a gap is honest, a mislabelled
// number is not.
//
// Staleness rule reused, not reinvented: `newestBarIsStale` from
// lib/data/candles.ts is the existing recency guard for daily bars, and the
// session-equality check below is strictly stronger than any age heuristic.

import type { Candle } from "@/lib/data/technicals";
import { fetchMassiveCandles, fetchUsCandles, fetchYahooCandles, newestBarIsStale } from "@/lib/data/candles";

export type BenchmarkMarket = "us" | "india";

export interface BenchmarkObservation {
  symbol: string;
  /** The BAR's own session date — never the cron run date. */
  sessionDate: string;
  close: number;
  /** Provider that produced the bar (yahoo, massive, ...). */
  source: string;
}

export type BenchmarkRejectionReason =
  | "benchmark_bars_unavailable"
  | "benchmark_bars_stale"
  | "benchmark_session_mismatch";

export type BenchmarkObservationResult =
  | { ok: true; observation: BenchmarkObservation }
  | { ok: false; reason: BenchmarkRejectionReason; detail: string; latestSessionDate: string | null };

/** VOO tracks the S&P 500 for the US book; ^NSEI is the NIFTY 50 for India. */
export function benchmarkSymbol(market: BenchmarkMarket): string {
  return market === "india" ? "^NSEI" : "VOO";
}

/**
 * Pure core: pick the bar for `expectedSessionDate`, or reject with a reason.
 *
 * Deliberately exact. The whole incident was a near-miss date being treated as
 * close enough, so "yesterday's close is fine" is not a branch that exists.
 */
export function selectBenchmarkObservation(
  candles: Candle[],
  symbol: string,
  source: string,
  expectedSessionDate: string,
): BenchmarkObservationResult {
  const usable = (candles ?? [])
    .filter(c => !!c?.date && Number.isFinite(Number(c.close)) && Number(c.close) > 0)
    .map(c => ({ date: String(c.date).slice(0, 10), close: Number(c.close) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (usable.length === 0) {
    return { ok: false, reason: "benchmark_bars_unavailable", latestSessionDate: null,
      detail: `${symbol}: no usable daily bars from ${source}` };
  }

  const latest = usable[usable.length - 1];
  const match = usable.find(c => c.date === expectedSessionDate);
  if (match) {
    return { ok: true, observation: { symbol, sessionDate: match.date, close: match.close, source } };
  }

  // No bar for the session we were asked about. Distinguish "the provider is
  // stranded" from "today's bar simply isn't published yet" — both refuse the
  // write, but they mean different things operationally.
  if (newestBarIsStale(usable as Candle[])) {
    return { ok: false, reason: "benchmark_bars_stale", latestSessionDate: latest.date,
      detail: `${symbol}: newest ${source} bar is ${latest.date}, beyond the daily-bar recency guard; refusing to store it under ${expectedSessionDate}` };
  }
  return { ok: false, reason: "benchmark_session_mismatch", latestSessionDate: latest.date,
    detail: `${symbol}: no ${source} bar for session ${expectedSessionDate} (newest is ${latest.date}); refusing to store it under ${expectedSessionDate}` };
}

/**
 * Fetch the benchmark's daily bars and resolve the observation for one session.
 *
 * US goes through `fetchUsCandles` so it inherits the existing provider ladder
 * and recency guard; India uses the same Yahoo daily-bar adapter that already
 * serves .NS/^NSEI symbols.
 */
export interface BenchmarkFetchers {
  us: (symbol: string) => Promise<{ candles: Candle[]; source: string }>;
  usFallback: (symbol: string) => Promise<Candle[]>;
  india: (symbol: string) => Promise<Candle[]>;
}

const DEFAULT_FETCHERS: BenchmarkFetchers = {
  us: (symbol) => fetchUsCandles(symbol, async () => [] as Candle[]),
  usFallback: (symbol) => fetchMassiveCandles(symbol),
  india: (symbol) => fetchYahooCandles(symbol),
};

export async function fetchBenchmarkObservation(
  market: BenchmarkMarket,
  expectedSessionDate: string,
  fetchers: BenchmarkFetchers = DEFAULT_FETCHERS,
): Promise<BenchmarkObservationResult> {
  const symbol = benchmarkSymbol(market);
  try {
    if (market === "us") {
      const { candles, source } = await fetchers.us(symbol);
      const primary = selectBenchmarkObservation(candles, symbol, source, expectedSessionDate);
      if (primary.ok || primary.reason !== "benchmark_session_mismatch") return primary;

      // `fetchUsCandles` accepts the FIRST provider whose newest bar is within a
      // generic 4-day recency guard. That guard is too weak for a caller that
      // needs one EXACT session: on 2026-08-17 Yahoo had not yet published the
      // settled VOO bar 15 minutes after the US close, so its newest bar was
      // 2026-08-14 — only 3 days old, therefore "fresh" — and the ladder
      // returned it without ever trying Massive, which DID have 2026-08-17
      // (close 710.27). The US book then recorded no benchmark at all, while
      // India (running 1h15m after its close) recorded one fine.
      //
      // So when the ladder's pick simply lacks the session, ask the next
      // provider directly. A mismatch is not the same as a stranded provider,
      // and only the mismatch is worth a second call.
      const fallbackCandles = await fetchers.usFallback(symbol);
      const secondary = selectBenchmarkObservation(fallbackCandles, symbol, "massive", expectedSessionDate);
      // If the fallback also cannot supply the session, report the ORIGINAL
      // rejection — it describes the provider the ladder actually chose.
      return secondary.ok ? secondary : primary;
    }
    const candles = await fetchers.india(symbol);
    return selectBenchmarkObservation(candles, symbol, "yahoo", expectedSessionDate);
  } catch (err) {
    return {
      ok: false, reason: "benchmark_bars_unavailable", latestSessionDate: null,
      detail: `${symbol}: daily-bar fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Cumulative benchmark return vs the first recorded observation.
 * Null baseline (or a non-positive one) yields null rather than a fake 0%.
 */
export function benchmarkReturnPct(close: number, baselineClose: number | null | undefined): number | null {
  const base = Number(baselineClose);
  if (!Number.isFinite(base) || base <= 0) return null;
  return ((close - base) / base) * 100;
}
