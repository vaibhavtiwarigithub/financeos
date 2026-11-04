import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fetchYahooCandles } from "@/lib/data/yahoo-candles";
import { BENCHMARK_BY_MARKET } from "@/lib/data/benchmark-series";
import { computeEventOutcome, EVENT_HORIZONS, type OhlcBar } from "@/lib/events/outcomes";
import { computeStoredEventOutcome, type StoredDailyReturn } from "@/lib/events/policy-returns";
import { requiresSymbol } from "@/lib/events/vocabulary";
import { fetchAllRows } from "@/lib/supabase/paginate";

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
  market_policy_event_context?: { event_id: number; market_policy_event_exposures?: { symbol: string }[] | null } | { event_id: number; market_policy_event_exposures?: { symbol: string }[] | null }[] | null;
}

function policyContext(ev: EventRow) {
  return Array.isArray(ev.market_policy_event_context) ? ev.market_policy_event_context[0] : ev.market_policy_event_context;
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

  let rows: EventRow[];
  try {
    rows = await fetchAllRows((from, to) => svc.from("market_events")
      .select("id, event_type, occurred_at, market, symbol, market_policy_event_context(event_id,market_policy_event_exposures(symbol))")
      .order("occurred_at", { ascending: true }).range(from, to), "market events") as EventRow[];
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "event read failed", matured: 0 };
  }

  // Already-matured (event, horizon, benchmark) triples are skipped, so a re-run
  // is cheap and the job is safe to schedule daily.
  let existing: any[];
  try {
    existing = await fetchAllRows((from, to) => svc.from("market_event_outcomes")
      .select("event_id, horizon_days, benchmark_symbol, subject_symbol, market_events!inner(event_type,symbol)")
      .order("id", { ascending: true }).range(from, to), "market event outcomes");
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "event outcome read failed", matured: 0 };
  }
  const done = new Set(
    existing.map((r: any) => {
      const event = Array.isArray(r.market_events) ? r.market_events[0] : r.market_events;
      const subject = r.subject_symbol ?? event?.symbol ?? r.benchmark_symbol;
      return `${r.event_id}|${r.horizon_days}|${r.benchmark_symbol}|${subject}`;
    }),
  );

  const cache = new Map<string, Promise<OhlcBar[]>>();
  const inserts: any[] = [];
  const skipped: Record<string, number> = {};
  const note = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };

  // Election/policy event returns are derived only from stored, point-in-time
  // daily-return rows. They never fall through to Yahoo or add provider calls.
  const policyEvents = rows.filter((ev) => ev.market === "us" && policyContext(ev));
  let policyMatured = 0;
  const policyBenchmark = BENCHMARK_BY_MARKET.us;
  for (const ev of policyEvents) {
    const exposures = policyContext(ev)?.market_policy_event_exposures ?? [];
    const symbols = [...new Set(exposures.map((x) => x.symbol.toUpperCase()))];
    if (!symbols.length) { note("policy_event_has_no_sourced_symbol_exposure"); continue; }
    const requiredKeys = symbols.flatMap((symbol) => [1, 5, 20, 60].map((horizon) => `${ev.id}|${horizon}|${policyBenchmark}|${symbol}`));
    if (requiredKeys.every((key) => done.has(key))) { note("policy_outcomes_already_matured"); continue; }
    if (Date.now() - started > 40_000) { note("policy_runtime_budget_deferred"); break; }
    const eventDay = ev.occurred_at.slice(0, 10);
    const lower = new Date(`${eventDay}T00:00:00.000Z`); lower.setUTCDate(lower.getUTCDate() - 900);
    const upper = new Date(`${eventDay}T00:00:00.000Z`); upper.setUTCDate(upper.getUTCDate() + 180);
    const rowsForEvent: StoredDailyReturn[] = [];
    try {
      for (let i = 0; i < symbols.length; i += 100) {
        const batch = [...new Set([...symbols.slice(i, i + 100), policyBenchmark])];
        const batchRows = await fetchAllRows((from, to) => svc.from("symbol_daily_returns")
          .select("symbol,session_date,previous_session_date,simple_return,price_basis,source,available_at")
          .eq("market", "us").in("symbol", batch)
          .gte("session_date", lower.toISOString().slice(0, 10)).lte("session_date", upper.toISOString().slice(0, 10))
          .order("available_at", { ascending: true }).range(from, to), "stored returns for policy event");
        rowsForEvent.push(...batchRows as StoredDailyReturn[]);
      }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : "stored policy return read failed", matured: 0 };
    }
    const bySymbol = new Map<string, StoredDailyReturn[]>();
    for (const row of rowsForEvent) {
      const values = bySymbol.get(row.symbol.toUpperCase()) ?? [];
      values.push(row);
      bySymbol.set(row.symbol.toUpperCase(), values);
    }
    for (const exposure of exposures) {
      const subjectSymbol = exposure.symbol.toUpperCase();
      for (const horizon of [1, 5, 20, 60]) {
        const key = `${ev.id}|${horizon}|${policyBenchmark}|${subjectSymbol}`;
        if (done.has(key)) continue;
        const out = computeStoredEventOutcome({
          subjectRows: bySymbol.get(subjectSymbol) ?? [],
          benchmarkRows: bySymbol.get(policyBenchmark) ?? [],
          subjectSymbol, benchmarkSymbol: policyBenchmark,
          occurredAt: ev.occurred_at, market: "us", horizonSessions: horizon,
        });
        if (!out) { note("policy_window_incomplete_or_return_unavailable"); continue; }
        inserts.push({
          event_id: ev.id, horizon_days: horizon, benchmark_symbol: policyBenchmark, subject_symbol: subjectSymbol,
          entry_date: out.entryDate, exit_date: out.exitDate, sessions_used: out.sessionsUsed,
          fwd_return: out.fwdReturn, benchmark_return: out.benchmarkReturn,
          benchmark_neutral_return: out.benchmarkNeutralReturn,
          matched_control_mean: out.matchedControlMean,
          matched_control_n: out.matchedControlN,
          matched_control_delta: out.matchedControlDelta,
          matching_method: "spy-regime-20-nearest-v1",
          forward_volatility: out.forwardVolatility,
          max_drawdown: out.maxDrawdown,
          max_adverse_excursion: out.maxAdverseExcursion,
          max_favorable_excursion: out.maxFavorableExcursion,
          input_fingerprint: out.inputFingerprint,
        });
        done.add(key);
        policyMatured++;
      }
    }
  }

  for (const ev of rows) {
    if (policyContext(ev)) continue;
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
      const key = `${ev.id}|${horizon}|${benchmark}|${subjectSymbol}`;
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
        input_fingerprint: null,
      });
    }
  }

  let inserted = 0;
  for (let i = 0; i < inserts.length; i += 200) {
    const { error: upErr } = await svc
      .from("market_event_outcomes")
      .upsert(inserts.slice(i, i + 200), { onConflict: "event_id,horizon_days,benchmark_symbol,subject_symbol", ignoreDuplicates: true });
    if (upErr) return { ok: false, error: upErr.message, matured: inserted, elapsedMs: Date.now() - started };
    inserted += Math.min(200, inserts.length - i);
  }

  return {
    ok: true,
    events: rows.length,
    matured: inserted,
    policyMatured,
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
