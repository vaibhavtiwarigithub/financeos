import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fetchYahooCandles } from "@/lib/data/yahoo-candles";
import { evaluatePathGeometry, PATH_CANDIDATES, type SimBar } from "@/lib/trading/exit-path-sim";
import { BENCHMARK_BY_MARKET } from "@/lib/data/benchmark-series";
import { coverageByHorizon, MIN_DISTINCT_DATES, type LabelRow } from "@/lib/shadows/label-coverage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Exit-PATH shadow — READ-ONLY. Replays real price bars under alternative exit
// rules, including TRAILING stops, which excursion statistics cannot evaluate at
// all (a trail only fires after a rise then a fall, so every interesting case is
// ambiguous from MFE/MAE alone).
//
// Changes nothing and writes nothing. No stop, target, trail, time stop, order
// or live/paper exit reads this.
//
// See features/portfolio-underperformance/DIAGNOSIS.md. The measured motivation:
// only 11-19% of profitable positions were still near their high at the horizon
// while 53-63% surrendered 70%+ of the move, and the live 7.5% trail is wider
// than the entire 2-4% excursion typical of an 11-day hold, so it can essentially
// never protect a gain.

const WALLCLOCK_BUDGET_MS = 45_000;
const MAX_SESSIONS = 25; // longest clock in the candidate set, plus margin

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const started = Date.now();
  const marketFilter = new URL(req.url).searchParams.get("market");
  const svc = createServiceClient();

  // Entry-eligible decisions only: a decision that never passed the eligibility
  // gate could not have become a position, so it cannot inform an exit rule.
  let q = svc.from("decision_observations")
    .select("ts, symbol, market, price_at_decision, entry_eligible")
    .eq("entry_eligible", true)
    .not("price_at_decision", "is", null)
    .order("ts", { ascending: true })
    .limit(2000);
  if (marketFilter) q = q.eq("market", marketFilter);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const decisions = (data ?? []) as Array<{ ts: string; symbol: string; market: string }>;

  // One candle fetch per SYMBOL, reused across every decision date on it.
  const series = new Map<string, Promise<SimBar[]>>();
  const loadSeries = (symbol: string): Promise<SimBar[]> => {
    let hit = series.get(symbol);
    if (!hit) {
      hit = fetchYahooCandles(symbol, "2y", { adjusted: true })
        .then((cs) => cs.map((c) => ({ date: c.date, high: c.high, low: c.low, close: c.close })))
        .catch(() => [] as SimBar[]);
      series.set(symbol, hit);
    }
    return hit;
  };

  const pathsByMarket = new Map<string, { paths: SimBar[][]; rows: LabelRow[] }>();
  let noSeries = 0;
  let truncated = false;

  for (const decision of decisions) {
    if (Date.now() - started > WALLCLOCK_BUDGET_MS) { truncated = true; break; }
    const bars = await loadSeries(decision.symbol);
    if (bars.length === 0) { noSeries++; continue; }

    // The entry bar is the first session ON OR AFTER the decision date. Using an
    // earlier bar would enter before the decision existed.
    const day = decision.ts.slice(0, 10);
    const start = bars.findIndex((b) => b.date >= day);
    if (start < 0) { noSeries++; continue; }
    const window = bars.slice(start, start + MAX_SESSIONS + 1);
    // A window that has not fully elapsed cannot be simulated for the longest
    // clock without inventing bars, so it is skipped rather than padded.
    if (window.length < 2) { noSeries++; continue; }

    const bucket = pathsByMarket.get(decision.market) ?? { paths: [], rows: [] };
    bucket.paths.push(window);
    bucket.rows.push({ date: day, symbol: decision.symbol, horizonDays: 10, entryEligible: true });
    pathsByMarket.set(decision.market, bucket);
  }

  // Benchmark closes per market, keyed by DATE so the excess leg can never be
  // joined positionally across differing holiday calendars. US and India each
  // use their own benchmark and are never pooled.
  //
  // ADJUSTED-CLOSE TRAP: fetchYahooCandles returns [] when `adjusted` is asked
  // for and the symbol has no adjclose series. ^NSEI is a PRICE INDEX and has
  // none, so the India benchmark came back empty and every excess figure was
  // silently unmatched — 334 of 334 — while the endpoint reported success.
  // Adjusted is still correct for SPY, which is an ETF and pays distributions;
  // unadjusted is correct for a price index, which has none to reinvest. So try
  // adjusted, fall back to raw, and REPORT which was used rather than hide it.
  const benchmarks = new Map<string, Map<string, number>>();
  const benchmarkBasis = new Map<string, "adjusted" | "unadjusted" | "unavailable">();
  for (const market of pathsByMarket.keys()) {
    const symbol = BENCHMARK_BY_MARKET[market];
    if (!symbol) continue;
    let bars = await loadSeries(symbol);
    let basis: "adjusted" | "unadjusted" | "unavailable" = "adjusted";
    if (bars.length === 0) {
      const raw = await fetchYahooCandles(symbol, "2y").catch(() => []);
      bars = raw.map((c) => ({ date: c.date, high: c.high, low: c.low, close: c.close }));
      basis = bars.length ? "unadjusted" : "unavailable";
    }
    benchmarkBasis.set(market, basis);
    benchmarks.set(market, new Map(bars.map((b) => [b.date, b.close])));
  }

  const markets = [...pathsByMarket.entries()].map(([market, { paths, rows }]) => {
    const coverage = coverageByHorizon(rows)[0];
    const benchmark = benchmarks.get(market);
    return {
      market,
      coverage: {
        decisions: paths.length,
        distinctDates: coverage?.distinctDates ?? 0,
        distinctSymbols: coverage?.distinctSymbols ?? 0,
        minDistinctDates: MIN_DISTINCT_DATES,
        sufficient: coverage?.sufficient ?? false,
      },
      benchmarkSymbol: BENCHMARK_BY_MARKET[market] ?? null,
      benchmarkBasis: benchmarkBasis.get(market) ?? "unavailable",
      results: PATH_CANDIDATES.map((c) => evaluatePathGeometry(paths, c.geometry, c.label, c.baseline === true, benchmark)),
      note: coverage?.sufficient
        ? "Coverage clears the date floor. Differences may be compared, subject to multiple-testing caveats across the candidate set."
        : `Only ${coverage?.distinctDates ?? 0} distinct decision date(s), below the floor of ${MIN_DISTINCT_DATES}. These numbers describe one regime and MUST NOT justify an exit-rule change.`,
    };
  }).sort((a, b) => a.market.localeCompare(b.market));

  return NextResponse.json({
    markets,
    symbolsFetched: series.size,
    decisionsConsidered: decisions.length,
    withoutUsableSeries: noSeries,
    truncated,
    method: "Excess is subject minus benchmark over the SAME entry-to-exit dates the rule chose, matched by date - a rule that exits earlier is compared against less benchmark exposure, which is the honest comparison. Real daily bars replayed from the first session on or after each decision date, entering at that bar's close. The entry bar is never evaluated for an exit. The trail anchors on the highest high seen BEFORE the current bar, so a bar cannot ratchet the stop on its own high and then breach it. When one bar's low breaches the stop AND its high reaches the target, the STOP is assumed first - the pessimistic branch - and counted in intrabarAmbiguous.",
    influence: "None. Changes no stop, target, trail, time stop, order or exit, and writes nothing.",
    elapsedMs: Date.now() - started,
  });
}
