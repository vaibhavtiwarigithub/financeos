import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { MIN_BETA_OVERLAP, TABLE } from "@/lib/data/return-observations";

export const dynamic = "force-dynamic";

// Return-observation COVERAGE REPORT (features/correlation-aware-construction §0).
//
// Answers one question: "is correlation measurable yet, and when will it be?"
// Read-only, owner-gated, per-market, never cross-summed. Nothing here is on the
// money path — this reports on evidence accumulation, it does not act on it.
//
// Expect ~0 viable pairs today. That is CORRECT: this contract only just started the
// clock. The number climbing over time is the signal that §0 item 2 becomes possible.
//
// Equivalent SQL (documented so this is answerable without the route):
//
//   -- per-market coverage + how many symbols clear the shared-session floor
//   select market,
//          count(distinct symbol)                                        as symbols,
//          count(*)                                                      as observations,
//          count(distinct as_of)                                         as sessions_captured,
//          min(as_of) as first_as_of, max(as_of) as last_as_of,
//          count(*) filter (where benchmark_beta is not null)            as measured_beta_rows,
//          count(distinct symbol) filter (where benchmark_overlap_sessions >= 60)
//                                                                        as symbols_ge_60_shared
//   from public.symbol_return_observations
//   group by market order by market;
//
//   -- why beta is missing, per market
//   select market, beta_unmeasurable_reason, count(*)
//   from public.symbol_return_observations
//   where benchmark_beta is null
//   group by market, beta_unmeasurable_reason order by market, 3 desc;

interface ObsRow {
  symbol: string;
  market: string;
  as_of: string;
  available_at: string;
  source: string | null;
  window_start: string;
  window_end: string;
  observation_count: number;
  daily_vol: number | null;
  benchmark_beta: number | null;
  benchmark_overlap_sessions: number;
  beta_unmeasurable_reason: string | null;
}

/** Calendar-day overlap of two [start, end] date windows. */
function windowOverlapDays(a: ObsRow, b: ObsRow): number {
  const start = Math.max(Date.parse(a.window_start), Date.parse(b.window_start));
  const end = Math.min(Date.parse(a.window_end), Date.parse(b.window_end));
  if (!(end >= start)) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}

/** Sessions per calendar day implied by an observation's own window. */
function density(o: ObsRow): number {
  const span = Math.floor((Date.parse(o.window_end) - Date.parse(o.window_start)) / 86400000) + 1;
  if (span <= 0) return 0;
  return o.observation_count / span;
}

export async function GET(req: Request) {
  try {
    const gate = await requireOwner();
    if (gate) return gate;

    const url = new URL(req.url);
    const minShared = Math.max(1, parseInt(url.searchParams.get("minShared") ?? String(MIN_BETA_OVERLAP), 10) || MIN_BETA_OVERLAP);

    const svc = createServiceClient();
    const { data, error } = await svc
      .from(TABLE)
      .select("symbol, market, as_of, available_at, source, window_start, window_end, observation_count, daily_vol, benchmark_beta, benchmark_overlap_sessions, beta_unmeasurable_reason")
      .order("as_of", { ascending: true });

    if (error) {
      return NextResponse.json(
        { error: "Coverage read failed", detail: error.message, hint: `Has migration 20260716210000_symbol_return_observations been applied?` },
        { status: 500 },
      );
    }

    const rows: ObsRow[] = (data ?? []) as ObsRow[];

    // Per market — NEVER cross-summed. Each market's pool stands alone.
    const markets: Record<string, any> = {};
    for (const market of ["us", "india"]) {
      const mine = rows.filter((r) => r.market === market);

      // Latest observation per symbol (rows are as_of-ascending, so last wins).
      const latest = new Map<string, ObsRow>();
      for (const r of mine) latest.set(r.symbol, r);
      const latestRows = [...latest.values()];

      // EXACT: shared sessions between a symbol and the market's benchmark.
      const symbolsAtFloor = latestRows.filter((r) => r.benchmark_overlap_sessions >= minShared);

      // Capture cadence — the "over time" axis. How many distinct sessions have we
      // been recording, and how many symbols on each.
      const byDay = new Map<string, Set<string>>();
      for (const r of mine) {
        if (!byDay.has(r.as_of)) byDay.set(r.as_of, new Set());
        byDay.get(r.as_of)!.add(r.symbol);
      }
      const timeline = [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([as_of, syms]) => ({ as_of, symbols: syms.size }));

      // Why beta is absent, so the gap is legible rather than guessed around.
      const reasons: Record<string, number> = {};
      for (const r of mine) {
        if (r.beta_unmeasurable_reason) reasons[r.beta_unmeasurable_reason] = (reasons[r.beta_unmeasurable_reason] ?? 0) + 1;
      }

      // PAIR VIABILITY — the §0 item-2 gate (>= 60 shared sessions per pair).
      // HONESTY: the table stores window bounds + a session COUNT, not the session
      // dates, so an exact per-pair intersection is NOT derivable from it. This is an
      // UPPER BOUND: the calendar-window overlap scaled by the sparser series'
      // session density. A pair below the floor here is definitively not viable; a
      // pair above it still needs the exact overlap re-derived from the candles when
      // an estimator is actually built. Labeled as such in the payload.
      let pairsAtFloor = 0;
      let pairsTotal = 0;
      for (let i = 0; i < latestRows.length; i++) {
        for (let j = i + 1; j < latestRows.length; j++) {
          pairsTotal++;
          const shared = windowOverlapDays(latestRows[i], latestRows[j]) * Math.min(density(latestRows[i]), density(latestRows[j]));
          if (shared >= minShared) pairsAtFloor++;
        }
      }

      markets[market] = {
        benchmark: market === "india" ? "^NSEI" : "SPY",
        symbols_observed: latest.size,
        observations: mine.length,
        sessions_captured: byDay.size,
        first_as_of: mine.length ? mine[0].as_of : null,
        last_as_of: mine.length ? mine[mine.length - 1].as_of : null,
        // Exact, per-symbol: shared sessions vs this market's benchmark.
        symbols_at_shared_session_floor: symbolsAtFloor.length,
        symbols_with_measured_beta: latestRows.filter((r) => r.benchmark_beta !== null).length,
        symbols_with_measured_vol: latestRows.filter((r) => r.daily_vol !== null).length,
        beta_unmeasurable_reasons: reasons,
        sources: [...new Set(mine.map((r) => r.source).filter(Boolean))],
        pair_viability: {
          basis: "upper_bound_window_overlap",
          note: "Window bounds + session counts are stored, not session dates — exact per-pair overlap must be re-derived from candles before any estimator uses it. Below the floor = definitively not viable.",
          pairs_total: pairsTotal,
          pairs_at_or_above_floor: pairsAtFloor,
        },
        timeline,
      };
    }

    return NextResponse.json({
      contract: "symbol_return_observations",
      status: "measure_only",
      note: "Evidence capture only. No scoring, sizing, eligibility, order or exit path reads these rows. The constructor remains on its conservative volatility/sector-proxy behavior.",
      min_shared_sessions: minShared,
      generated_at: new Date().toISOString(),
      markets,
    });
  } catch (err) {
    console.error("[return-observation-coverage] error:", err);
    return NextResponse.json({ error: "Failed to build coverage report" }, { status: 500 });
  }
}
