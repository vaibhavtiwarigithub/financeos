import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fetchYahooCandles } from "@/lib/data/yahoo-candles";
import { BENCHMARK_BY_MARKET } from "@/lib/data/benchmark-series";
import { computeEventOutcome, EVENT_HORIZONS, type OhlcBar } from "@/lib/events/outcomes";
import { requiresSymbol } from "@/lib/events/vocabulary";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Event ledger step 2 — mature forward paths for recorded events.
//
// MEASUREMENT ONLY. Writes market_event_outcomes and nothing else. No score,
// eligibility, size, entry, exit, promotion or broker path reads either table.
//
// WHY YAHOO AND NOT price_cache
// price_cache only reaches back to 2025-07-22 for SPY, while the earliest
// recorded event is 2025-02-01 — it cannot mature 9 of the 19 existing rows.
// fetchYahooCandles is the repo's existing keyless deep-history source for BOTH
// markets (measured 5y depth for US and NS symbols alike) and costs one request
// per symbol per run, cached an hour by the fetch layer.
//
// `adjusted: true` is deliberate and NOT the default the live scoring path uses:
// a return study must not read a split or a distribution as alpha.

interface EventRow {
  id: number;
  event_type: string;
  occurred_at: string;
  market: string;
  symbol: string | null;
}

const RANGE = "3y"; // covers the earliest recorded event with margin

async function loadSeries(symbol: string, cache: Map<string, Promise<OhlcBar[]>>): Promise<OhlcBar[]> {
  let hit = cache.get(symbol);
  if (!hit) {
    hit = fetchYahooCandles(symbol, RANGE, { adjusted: true })
      .then((cs) => cs.map((c) => ({ date: c.date, high: c.high, low: c.low, close: c.close })))
      .catch(() => [] as OhlcBar[]);
    cache.set(symbol, hit);
  }
  return hit;
}

async function run() {
  const started = Date.now();
  const svc = createServiceClient();

  const { data: events, error } = await svc
    .from("market_events")
    .select("id, event_type, occurred_at, market, symbol")
    .order("occurred_at", { ascending: true })
    .limit(500);
  if (error) return { ok: false, error: error.message, matured: 0 };

  const rows = (events ?? []) as EventRow[];

  // Already-matured (event, horizon, benchmark) triples are skipped, so a re-run
  // is cheap and the job is safe to schedule daily.
  const { data: existing } = await svc
    .from("market_event_outcomes")
    .select("event_id, horizon_days, benchmark_symbol");
  const done = new Set(
    (existing ?? []).map((r: any) => `${r.event_id}|${r.horizon_days}|${r.benchmark_symbol}`),
  );

  const cache = new Map<string, Promise<OhlcBar[]>>();
  const inserts: any[] = [];
  const skipped: Record<string, number> = {};
  const note = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };

  for (const ev of rows) {
    const benchmark = BENCHMARK_BY_MARKET[ev.market];
    if (!benchmark) { note("no_benchmark_for_market"); continue; }

    // An idiosyncratic event with no symbol has nothing to measure ON. It is
    // recorded as skipped rather than measured against the index, which would
    // silently turn a per-company claim into a market-wide one.
    if (requiresSymbol(ev.event_type) && !ev.symbol) { note("idiosyncratic_without_symbol"); continue; }

    // For a market-wide event the subject IS the benchmark, so the
    // benchmark-neutral leg is 0 by construction — recorded, not hidden.
    const subjectSymbol = ev.symbol ?? benchmark;

    const [subject, bench] = await Promise.all([
      loadSeries(subjectSymbol, cache),
      loadSeries(benchmark, cache),
    ]);
    if (subject.length === 0) { note("no_price_series"); continue; }

    for (const horizon of EVENT_HORIZONS) {
      const key = `${ev.id}|${horizon}|${benchmark}`;
      if (done.has(key)) { note("already_matured"); continue; }

      const out = computeEventOutcome(subject, bench, ev.occurred_at, ev.market, horizon);
      // Null means the window has not fully elapsed. NOT a zero return — an
      // unmatured horizon must stay absent so the base rate's n stays honest.
      if (!out) { note("horizon_not_elapsed"); continue; }

      inserts.push({
        event_id: ev.id,
        horizon_days: horizon,
        benchmark_symbol: benchmark,
        subject_symbol: subjectSymbol,
        entry_date: out.entryDate,
        exit_date: out.exitDate,
        sessions_used: out.sessionsUsed,
        fwd_return: out.fwdReturn,
        benchmark_return: out.benchmarkReturn,
        benchmark_neutral_return: out.benchmarkNeutralReturn,
        max_adverse_excursion: out.maxAdverseExcursion,
        max_favorable_excursion: out.maxFavorableExcursion,
      });
    }
  }

  let inserted = 0;
  for (let i = 0; i < inserts.length; i += 200) {
    const { error: upErr } = await svc
      .from("market_event_outcomes")
      .upsert(inserts.slice(i, i + 200), { onConflict: "event_id,horizon_days,benchmark_symbol" });
    if (upErr) return { ok: false, error: upErr.message, matured: inserted, elapsedMs: Date.now() - started };
    inserted += Math.min(200, inserts.length - i);
  }

  return {
    ok: true,
    events: rows.length,
    matured: inserted,
    skipped,
    horizons: EVENT_HORIZONS,
    elapsedMs: Date.now() - started,
  };
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  return NextResponse.json(await run());
}

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  return NextResponse.json(await run());
}
