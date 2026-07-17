import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { DAILY_RETURNS_TABLE, MIN_BETA_OVERLAP, TABLE } from "@/lib/data/return-observations";

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

const PAGE_SIZE = 1000;

async function loadAllRows<T>(fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message ?? "coverage query failed");
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export async function GET(req: Request) {
  try {
    const gate = await requireOwner();
    if (gate) return gate;

    const url = new URL(req.url);
    const minShared = Math.max(1, parseInt(url.searchParams.get("minShared") ?? String(MIN_BETA_OVERLAP), 10) || MIN_BETA_OVERLAP);

    const svc = createServiceClient();
    const [rows, dailyData] = await Promise.all([
      loadAllRows<ObsRow>((from, to) => svc.from(TABLE)
        .select("symbol, market, as_of, available_at, source, window_start, window_end, observation_count, daily_vol, benchmark_beta, benchmark_overlap_sessions, beta_unmeasurable_reason")
        .order("as_of", { ascending: true })
        .range(from, to)),
      loadAllRows<{ symbol: string; market: string; session_date: string }>((from, to) => svc
        .from(DAILY_RETURNS_TABLE)
        .select("symbol, market, session_date")
        .range(from, to)),
    ]);

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

      // Exact pair viability from frozen per-session dates. Provider revisions
      // collapse to one symbol/date for coverage; the estimator will resolve the
      // point-in-time revision and enforce compatible price bases.
      const sessionsBySymbol = new Map<string, Set<string>>();
      for (const r of (dailyData ?? []) as Array<{ symbol: string; market: string; session_date: string }>) {
        if (r.market !== market) continue;
        if (!sessionsBySymbol.has(r.symbol)) sessionsBySymbol.set(r.symbol, new Set());
        sessionsBySymbol.get(r.symbol)!.add(r.session_date);
      }
      const pairSymbols = [...sessionsBySymbol.keys()].sort();
      let pairsAtFloor = 0;
      let pairsTotal = 0;
      for (let i = 0; i < pairSymbols.length; i++) {
        for (let j = i + 1; j < pairSymbols.length; j++) {
          pairsTotal++;
          const a = sessionsBySymbol.get(pairSymbols[i])!;
          const b = sessionsBySymbol.get(pairSymbols[j])!;
          const smaller = a.size <= b.size ? a : b;
          const larger = a.size <= b.size ? b : a;
          let shared = 0;
          for (const date of smaller) if (larger.has(date)) shared++;
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
          basis: "exact_frozen_session_intersection",
          note: "Exact date overlap from immutable per-session rows. An estimator must still select point-in-time revisions and compatible price bases.",
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
