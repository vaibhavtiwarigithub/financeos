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
import { fetchUpstoxIndexCandles } from "@/lib/data/upstox";
import { fetchYahooQuotes } from "@/lib/india-data";
import { expectedNewestSession } from "@/lib/data/completed-candles";

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
 * A benchmark level may be useful for display and later settlement even when
 * it is provisional or single-source. It is not, however, enough evidence for
 * an alpha claim. Keep this decision centralized so the two paper-performance
 * writers cannot silently disagree.
 */
export const CONFIRMED_BENCHMARK_SOURCES: Record<BenchmarkMarket, readonly string[]> = {
  // US: any provider that supplied a SETTLED daily bar for the exact session.
  //
  // Bare `yahoo` was removed on 2026-08-27. It was listed as confirmed, but a
  // Yahoo daily bar read at 16:15 ET is an IN-PROGRESS bar for the session that
  // has only just closed — it carries the right date and an unsettled value, so
  // the exact-session rule cannot catch it. Measured against settled closes:
  // 08-25 stored 702.74 vs 704.02 (0.18% wrong) and 08-27 stored 708.56 vs
  // 708.75, while the three rows humbly labelled `yahoo_quote(provisional)` were
  // EXACT. The confirmed label was on the wrong rows.
  //
  // `yahoo(settled)` is written only by the next-session confirmation pass, so
  // it means the bar was read after the session finished settling.
  // `yahoo_quote(provisional)` remains deliberately absent.
  us: ["yahoo(settled)", "massive", "eodhd", "twelvedata", "alpha_vantage"],
  // India: the value must come from the EXCHANGE-backed source.
  //
  // Loosened 2026-08-27 to admit `upstox(yahoo_disagreed)`. The original rule
  // demanded two-vendor agreement, written when neither source was trusted over
  // the other. Upstox is now declared authoritative (it is a broker API carrying
  // official exchange data, and on a disagreement its value is the one stored),
  // so refusing to publish alpha on those rows suppressed a CORRECT exchange
  // close because the SECONDARY source was wrong. Measured on the 2026-08-19..27
  // backfill: Yahoo disagreed on six of seven sessions by up to 0.67%, and Yahoo
  // was the one in error every time.
  //
  // `upstox(unconfirmed)` stays OUT: there the second source never resolved the
  // session at all, so nothing corroborates that Upstox returned the right bar
  // for the right day — which is a different claim from "the two disagreed and
  // we kept the authoritative one". `yahoo(unconfirmed)` stays out because the
  // value is not exchange-backed at all.
  india: ["upstox+yahoo", "upstox(yahoo_disagreed)"],
} as const;

export function isConfirmedBenchmarkObservation(market: BenchmarkMarket, source: string | null | undefined): boolean {
  if (!source) return false;
  // ALLOWLIST, not exclusion.
  //
  // This was `!source.includes("provisional") && !source.includes("unconfirmed")`
  // for US, which fails OPEN: any source string added later that is provisional
  // but happens not to contain those substrings would silently authorise an
  // alpha claim. Every other guard in this area fails closed, and an unknown
  // provenance is exactly where the conservative answer is "not confirmed".
  return CONFIRMED_BENCHMARK_SOURCES[market].includes(source);
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
  /** Exchange-backed second source for the India index (Upstox). */
  indiaCrossCheck: (symbol: string) => Promise<Candle[]>;
  /**
   * Last-traded QUOTE for the US benchmark. Used only when no vendor has
   * published the session's daily bar yet — see the guard in
   * `fetchBenchmarkObservation`.
   */
  usQuote: (symbol: string) => Promise<{ price: number; stale: boolean } | null>;
  /**
   * Injectable completed-session resolver. This keeps the quote fallback
   * deterministic in tests while production continues to use the market
   * calendar-aware resolver below.
   */
  expectedUsSession?: () => string;
}

/**
 * Largest tolerated gap between two providers quoting the SAME index session.
 * An index close is one published number, so any real disagreement is a data
 * fault, not rounding. 5bps leaves room for float/rounding only.
 */
export const BENCHMARK_CROSSCHECK_TOLERANCE_PCT = 0.05;

const DEFAULT_FETCHERS: BenchmarkFetchers = {
  us: (symbol) => fetchUsCandles(symbol, async () => [] as Candle[]),
  usFallback: (symbol) => fetchMassiveCandles(symbol),
  india: (symbol) => fetchYahooCandles(symbol),
  indiaCrossCheck: (symbol) => fetchUpstoxIndexCandles(symbol),
  usQuote: async (symbol) => {
    const q = await fetchYahooQuotes([symbol], "us");
    const hit = q[symbol.toUpperCase()];
    return hit && hit.price > 0 ? { price: hit.price, stale: !!hit.stale } : null;
  },
  expectedUsSession: () => expectedNewestSession("us"),
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
      if (secondary.ok) return secondary;

      // LAST RESORT: the session's last-traded QUOTE.
      //
      // The rule at the top of this file — "a benchmark observation is a DAILY
      // BAR, not a quote" — exists because the original defect was an
      // UNSESSION-IDENTIFIED quote stamped with the cron run date. The quote
      // itself was never the problem; the missing session identity was.
      //
      // At 16:15 ET no vendor has published VOO's settled bar (measured
      // 2026-08-19/20: Yahoo's chart endpoint lacks it, Massive grouped
      // publishes next-day, Massive /range still ends yesterday), so US
      // bench_nav was NULL two sessions running while NAV itself was fine.
      //
      // Consistency argument: NAV is now marked from the same 16:15 print, so a
      // 16:15 benchmark is LIKE-FOR-LIKE. Pairing a 16:15 NAV with a settled
      // close is the greater inconsistency.
      //
      // HARD GUARD: only when the session being asked about is the one that has
      // just closed. A quote says nothing about any OTHER session, so this can
      // never backfill history — it resolves today or not at all. The source
      // says `provisional` so the settle pass can revisit it.
      if ((fetchers.expectedUsSession?.() ?? expectedNewestSession("us")) === expectedSessionDate) {
        const quote = await fetchers.usQuote(symbol).catch(() => null);
        if (quote && quote.price > 0 && !quote.stale) {
          return {
            ok: true,
            observation: {
              symbol,
              sessionDate: expectedSessionDate,
              close: quote.price,
              source: "yahoo_quote(provisional)",
            },
          };
        }
      }
      // Nothing could supply the session — report the ORIGINAL rejection, which
      // describes the provider the ladder actually chose.
      return primary;
    }
    // INDIA — two independent sources, because the exact-session rule validates
    // the DATE and cannot validate the VALUE.
    //
    // Yahoo's ^NSEI series carries bars whose close is NULL and briefly serves a
    // PROVISIONAL number on those sessions before dropping it. On 2026-08-18 that
    // wrote 24245.699 into paper_performance when the settled NIFTY 50 close was
    // 24154.9 — 0.375% wrong, undetectable from Yahoo alone because Yahoo agreed
    // with itself. India had no second source (Massive is US-equities-only), so
    // the error was invisible until an exchange-backed provider was compared.
    //
    // Upstox is a broker API carrying official exchange data, so it is the
    // AUTHORITATIVE side: when both resolve the session, Upstox supplies the
    // value and Yahoo is the check. Yahoo still serves alone if Upstox is
    // unavailable (no token, outage) — a single-source benchmark beats none —
    // but the source string then says so plainly.
    const [yahooCandles, crossCandles] = await Promise.all([
      fetchers.india(symbol),
      fetchers.indiaCrossCheck(symbol).catch(() => [] as Candle[]),
    ]);
    const yahooPick = selectBenchmarkObservation(yahooCandles, symbol, "yahoo", expectedSessionDate);
    const crossPick = selectBenchmarkObservation(crossCandles, symbol, "upstox", expectedSessionDate);

    if (crossPick.ok && yahooPick.ok) {
      const a = crossPick.observation.close;
      const b = yahooPick.observation.close;
      const deltaPct = a > 0 ? (Math.abs(a - b) / a) * 100 : Number.POSITIVE_INFINITY;
      if (deltaPct <= BENCHMARK_CROSSCHECK_TOLERANCE_PCT) {
        return { ok: true, observation: { ...crossPick.observation, source: "upstox+yahoo" } };
      }
      // Disagreement is recorded in the source, not hidden: the exchange value
      // is used, and the label states that the two providers did not agree.
      return { ok: true, observation: { ...crossPick.observation, source: "upstox(yahoo_disagreed)" } };
    }
    if (crossPick.ok) return { ok: true, observation: { ...crossPick.observation, source: "upstox(unconfirmed)" } };
    if (yahooPick.ok) return { ok: true, observation: { ...yahooPick.observation, source: "yahoo(unconfirmed)" } };
    // Neither resolved the session — report the primary's reason.
    return yahooPick;
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

// ── Deferred confirmation of India benchmark sessions ────────────────────────
//
// Upstox's /v3/historical-candle NEVER returns the current session — verified
// on every cached payload from 2026-08-19 to 2026-08-27, whose newest bar is
// always the PREVIOUS trading day. So the live cross-check can never resolve
// today's session from Upstox: `selectBenchmarkObservation` correctly refuses,
// and the row is written `yahoo(unconfirmed)`.
//
// That is why India ran unconfirmed from 2026-08-19 onward while the two
// `upstox` rows (08-14, 08-18) only exist because they were backfilled a day
// later. It was never a token, key-mapping or outage problem: the fetch
// succeeded every single day and simply did not contain the bar being asked for.
//
// The fix is not to chase an intraday endpoint — an intraday bar is not a
// settled close, which is the whole point of using the exchange-backed source.
// Instead the row is confirmed on a LATER run, once Upstox publishes the
// settled bar, exactly like the settle-check pass does for marks.
//
// Upstox is authoritative (see the live path above), so confirmation REPLACES
// the provisional Yahoo value with the settled exchange close. These rows are
// self-labelled provisional; upgrading one is completing a deliberately
// deferred write, not rewriting a decision. Confirmed rows are never touched.

export type BenchmarkConfirmation = {
  date: string;
  /** Null when the row never resolved — this is a FILL, not a correction. */
  storedClose: number | null;
  settledClose: number;
  /** Null for a fill: there was no prior value to disagree with. */
  deltaPct: number | null;
  /** New provenance: agreement, or an explicit record that they did not agree. */
  source: string;
};

/** Pure core: decide which provisional rows can now be confirmed. */
/**
 * Per-market rules for what counts as still-provisional, and what provenance to
 * stamp once the settled bar arrives.
 *
 * INDIA — eligible when the stored value came from Yahoo, the only case where
 * Upstox is a genuine SECOND source. Anything already carrying exchange
 * provenance ("upstox", "upstox+yahoo", "upstox(...)") is final by construction;
 * confirming it would compare Upstox against itself. This deliberately covers
 * every provisional Yahoo label, not just `yahoo(unconfirmed)`. An earlier draft
 * also required the string to contain "unconfirmed"; that guard was untestable
 * (every non-Yahoo source is already excluded) and wrong, because it would have
 * stranded a `yahoo_quote(provisional)` row forever.
 *
 * US — eligible when the row was captured DURING the session it describes, or
 * never resolved at all. Measured 2026-08-27 against settled VOO closes: the
 * three `yahoo_quote(provisional)` rows were exact, while the two rows labelled
 * plain `yahoo` — which CONFIRMED_BENCHMARK_SOURCES treats as confirmed — were
 * both WRONG (08-25 off 1.28 = 0.18%, 08-27 off 0.19). A same-session Yahoo
 * DAILY BAR read at 16:15 ET is an in-progress bar, not a settled close, and it
 * was being stamped with confirmed provenance. `massive` rows are genuinely
 * settled (its grouped endpoint publishes next-day) and are left alone.
 */
export const CONFIRMATION_POLICY: Record<BenchmarkMarket, {
  isProvisional: (source: string | null) => boolean;
  label: (deltaPct: number | null) => string;
}> = {
  india: {
    isProvisional: (source) => (source ?? "").startsWith("yahoo"),
    label: (deltaPct) =>
      deltaPct != null && deltaPct <= BENCHMARK_CROSSCHECK_TOLERANCE_PCT
        ? "upstox+yahoo"
        : "upstox(yahoo_disagreed)",
  },
  us: {
    isProvisional: (source) => {
      const src = (source ?? "").trim();
      if (src === "") return true;                 // never resolved — fill it
      if (src.includes("provisional")) return true; // 16:15 ET quote
      if (src === "yahoo") return true;             // 16:15 ET in-progress daily bar
      return false;                                 // massive/eodhd/... are settled
    },
    // One unambiguous terminal label, so a confirmed row is never revisited.
    label: () => "yahoo(settled)",
  },
} as const;

export function planBenchmarkConfirmations(
  rows: Array<{ date: string; bench_nav: number | null; bench_source: string | null }>,
  settledByDate: Map<string, number>,
  market: BenchmarkMarket = "india",
): BenchmarkConfirmation[] {
  const policy = CONFIRMATION_POLICY[market];
  const out: BenchmarkConfirmation[] = [];
  for (const row of rows) {
    if (!policy.isProvisional(row.bench_source)) continue;
    const settled = settledByDate.get(row.date);
    if (settled == null || !Number.isFinite(settled) || settled <= 0) continue;
    const storedRaw = Number(row.bench_nav);
    const hasStored = Number.isFinite(storedRaw) && storedRaw > 0;
    // A row that never resolved has nothing to compare against — it is a FILL,
    // not a disagreement. Reporting a fabricated 0% delta would read as
    // agreement between two sources when only one ever existed.
    const deltaPct = hasStored ? (Math.abs(settled - storedRaw) / settled) * 100 : null;
    // India requires a stored Yahoo value: without one there is no second
    // opinion, so "upstox+yahoo" would be a false provenance claim.
    if (!hasStored && market === "india") continue;
    out.push({
      date: row.date,
      storedClose: hasStored ? storedRaw : null,
      settledClose: settled,
      deltaPct,
      source: policy.label(deltaPct),
    });
  }
  return out;
}

/**
 * Apply deferred confirmations for one market's provisional benchmark rows.
 *
 * Runs on a LATER session than the row it confirms, because the exchange bar
 * for a session is not published until after it. India only: Upstox is the
 * India cross-source, and the US ladder already resolves same-session bars.
 *
 * Writes the settled exchange close over the provisional Yahoo one and clears
 * `bench_return_pct` / `alpha_pct`, which were derived from the superseded
 * value. Rows carrying exchange provenance are never revisited.
 */
export async function confirmBenchmarkSessions(
  svc: any,
  market: BenchmarkMarket,
  fetchSettledCandles: (symbol: string) => Promise<Candle[]>,
  lookbackDays = 21,
): Promise<{ confirmed: BenchmarkConfirmation[]; scanned: number; reason?: string }> {
  const symbol = benchmarkSymbol(market);
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await svc
    .from("paper_performance")
    .select("date, bench_nav, bench_source")
    .eq("market", market)
    // Deliberately NOT filtered to snapshot_type='eod'. A past session's
    // benchmark is settled regardless of how the NAV row was labelled, and
    // filtering here would permanently strand any row left `intraday` because
    // PositionMonitor did not run that day (PaperTrader inserts intraday, and
    // only PositionMonitor's upsert promotes it). Today's row is unaffected
    // either way: no settled bar exists for it, so it is never eligible.
    .gte("date", since)
    .order("date", { ascending: true });
  if (error) return { confirmed: [], scanned: 0, reason: `read_failed: ${error.message}` };

  const rows = (data ?? []) as Array<{ date: string; bench_nav: number | null; bench_source: string | null }>;
  if (rows.length === 0) return { confirmed: [], scanned: 0 };

  const candles = await fetchSettledCandles(symbol).catch(() => [] as Candle[]);
  const settled = new Map<string, number>();
  for (const c of candles ?? []) {
    const close = Number(c?.close);
    if (c?.date && Number.isFinite(close) && close > 0) settled.set(String(c.date).slice(0, 10), close);
  }
  if (settled.size === 0) return { confirmed: [], scanned: rows.length, reason: "no_settled_bars" };

  const plan = planBenchmarkConfirmations(rows, settled, market);
  const applied: BenchmarkConfirmation[] = [];
  for (const c of plan) {
    const { error: upErr } = await svc
      .from("paper_performance")
      .update({
        bench_nav: c.settledClose,
        bench_source: c.source,
        bench_session_date: c.date,
        // Derived from the value being replaced — recomputed by the normal path,
        // never left stale against a number that no longer exists.
        bench_return_pct: null,
        alpha_pct: null,
      })
      .eq("market", market)
      .eq("date", c.date)
      .eq("snapshot_type", "eod");
    if (!upErr) applied.push(c);
  }
  return { confirmed: applied, scanned: rows.length };
}
