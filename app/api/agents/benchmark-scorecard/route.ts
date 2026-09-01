import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { fetchMassiveCandles } from "@/lib/data/candles";
import { fetchYahooCandles } from "@/lib/data/yahoo-candles";
import type { Candle } from "@/lib/data/technicals";
import { verifyCronSecret } from "@/lib/auth/cron";
import { reportIssue } from "@/lib/system-health";
import { pickFreshestProvider, newestBarDate } from "@/lib/data/benchmark-ingest";
import {
  BENCHMARK_HORIZONS,
  computeBenchmarkScorecardRow,
  latestAsOf,
  type BenchmarkConfig,
  type LevelPoint,
} from "@/lib/analytics/benchmark-alpha";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MARKETS = ["us", "india"] as const;
const CURRENCY = { us: "USD", india: "INR" } as const;

function asLevel(row: any, field: string): LevelPoint {
  return { date: String(row.date).slice(0, 10), level: row[field] == null ? null : Number(row[field]) };
}

async function requireOwnerOrCron(req: NextRequest) {
  if (verifyCronSecret(req)) return null;
  return requireOwner();
}

async function loadBenchmarks(svc: any): Promise<BenchmarkConfig[]> {
  const { data, error } = await svc
    .from("benchmarks")
    .select("id, market, label, symbol, provider_symbol, currency, is_primary")
    .eq("enabled", true)
    .order("market", { ascending: true });
  if (error) throw new Error(`benchmarks read failed: ${error.message}`);
  return (data ?? []) as BenchmarkConfig[];
}

async function upsertPaperObservations(svc: any, benchmark: BenchmarkConfig) {
  // PRIMARY ONLY. `paper_performance.bench_nav` holds ONE benchmark per market
  // (VOO for US, ^NSEI for India). Running this for a secondary benchmark would
  // copy the primary's levels under the secondary's benchmark_id — a mislabelled
  // series indistinguishable from real data, the same defect class as the
  // 2026-08-12/13 VOO session mix-up this file already guards against.
  // Secondary benchmarks get their own provider-backed observations instead.
  if (!benchmark.is_primary) return;
  // W5: read the benchmark's own session date when the column exists. A level
  // whose session does not match the row it sits on is a mislabelled
  // observation (VOO's 2026-08-11 close was stored under both 2026-08-12 and
  // 2026-08-13) and must never be promoted into the scorecard series.
  const query = (cols: string) => svc
    .from("paper_performance")
    .select(cols)
    .eq("market", benchmark.market)
    .not("bench_nav", "is", null)
    .order("date", { ascending: true })
    .limit(500);
  // Falls back to the legacy shape until the provenance migration is applied.
  let { data, error } = await query("date, bench_nav, bench_session_date, bench_source");
  if (error) ({ data, error } = await query("date, bench_nav"));
  if (error) return;
  const rows = (data ?? [])
    .map((r: any) => {
      const date = String(r.date).slice(0, 10);
      const session = r.bench_session_date ? String(r.bench_session_date).slice(0, 10) : null;
      return {
        benchmark_id: benchmark.id,
        component_symbol: benchmark.provider_symbol ?? benchmark.symbol ?? benchmark.label,
        date,
        close: Number(r.bench_nav),
        currency: benchmark.currency,
        provider: r.bench_source ? String(r.bench_source) : "paper_performance",
        // A level that PROVES it belongs to a different session is rejected —
        // `loadBenchmarkLevels` only reads source_status='ok', so a mislabelled
        // close can no longer enter the scorecard series. Legacy rows carry no
        // session date and keep their existing status; the contaminated
        // 2026-07-27..08-14 window is tainted upstream and deliberately not
        // rewritten here.
        source_status: !(Number(r.bench_nav) > 0) ? "missing"
          : session != null && session !== date ? "session_mismatch"
          : "ok",
        error: session != null && session !== date
          ? `benchmark close belongs to session ${session}, not ${date}`
          : null,
      };
    })
    .filter((r: any) => Number.isFinite(r.close) && r.close > 0);
  if (rows.length) {
    await svc.from("benchmark_price_observations").upsert(rows, { onConflict: "benchmark_id,component_symbol,date" });
  }
}

async function upsertLiveObservations(svc: any, benchmark: BenchmarkConfig) {
  const { data, error } = await svc
    .from("live_performance")
    .select("date, bench_nav, market, currency, book_scope")
    .eq("market", benchmark.market)
    .eq("currency", benchmark.currency)
    .eq("book_scope", "all_live_accounts")
    .not("bench_nav", "is", null)
    .order("date", { ascending: true })
    .limit(500);
  if (error) return;
  const byDate = new Map<string, number>();
  for (const r of (data ?? []) as any[]) {
    const close = Number(r.bench_nav);
    if (Number.isFinite(close) && close > 0) byDate.set(String(r.date).slice(0, 10), close);
  }
  const rows = [...byDate.entries()].map(([date, close]) => ({
    benchmark_id: benchmark.id,
    component_symbol: benchmark.provider_symbol ?? benchmark.symbol ?? benchmark.label,
    date,
    close,
    currency: benchmark.currency,
    provider: "live_performance",
    source_status: "ok",
    error: null,
  }));
  if (rows.length) {
    await svc.from("benchmark_price_observations").upsert(rows, { onConflict: "benchmark_id,component_symbol,date" });
  }
}

/**
 * Daily closes for a SECONDARY benchmark, fetched from its own provider.
 *
 * A secondary benchmark has no column in `paper_performance`, so its series is
 * sourced directly and stored per benchmark_id. Each observation carries the
 * bar's own date — never a run date — so the session-alignment rule this file
 * enforces for the primary holds identically here.
 */
async function upsertProviderObservations(
  svc: any,
  benchmark: BenchmarkConfig,
  expectedSession: string | null,
) {
  if (benchmark.is_primary) return;
  const symbol = benchmark.provider_symbol ?? benchmark.symbol;
  if (!symbol) return;

  // FALL BACK ON STALENESS, NOT JUST EMPTINESS.
  //
  // This previously fell back only when the preferred provider returned NOTHING
  // (`if (!candles.length)`). A provider that returns 500 bars but none recent
  // passes that check, so the benchmark goes stale silently and forever.
  // Measured 2026-09-01: XLF had fallen back to Yahoo (empty from Massive) and
  // was current at 08-31, while XLK stayed on Massive with 500 bars ending
  // 08-24 — eight days stale — and QQQ ended 08-28. The chart then truncated the
  // PORTFOLIO series to the stale benchmark's coverage, reporting +0.010%
  // instead of +1.345% for an identical window.
  //
  // Both providers are cheap here (Yahoo is keyless and unpaced; at most two US
  // secondaries), so fetch both and keep whichever reaches further forward.
  const attempts: Array<{ provider: string; candles: Candle[] }> = [];
  if (benchmark.market === "india") {
    attempts.push({ provider: "yahoo", candles: await fetchYahooCandles(symbol, "2y").catch(() => [] as Candle[]) });
  } else {
    attempts.push({ provider: "massive", candles: await fetchMassiveCandles(symbol, 500).catch(() => [] as Candle[]) });
    attempts.push({ provider: "yahoo", candles: await fetchYahooCandles(symbol, "2y").catch(() => [] as Candle[]) });
  }

  const usable = attempts.filter((a) => a.candles.length > 0);
  if (!usable.length) {
    await reportIssue({
      issueKey: `benchmark-ingest-empty:${benchmark.id}`,
      severity: "warn",
      category: "data",
      title: `${benchmark.label}: no benchmark bars from any provider`,
      detail: `Tried ${attempts.map((a) => a.provider).join(", ")} for ${symbol}. The comparison chart will show no benchmark line for this selection.`,
    }, svc).catch(() => {});
    return;
  }

  // Freshest wins; ties keep the preferred provider (first attempt).
  const best = pickFreshestProvider(attempts)!;

  const rows = best.candles
    .filter((c) => !!c?.date && Number.isFinite(Number(c.close)) && Number(c.close) > 0)
    .map((c) => ({
      benchmark_id: benchmark.id,
      component_symbol: symbol,
      date: String(c.date).slice(0, 10),
      close: Number(c.close),
      currency: benchmark.currency,
      provider: best.provider,
      source_status: "ok",
      error: null,
    }));
  if (rows.length) {
    // A failed write was previously discarded, so an ingestion outage looked
    // identical to a quiet day.
    const { error } = await svc.from("benchmark_price_observations")
      .upsert(rows, { onConflict: "benchmark_id,component_symbol,date" });
    if (error) {
      await reportIssue({
        issueKey: `benchmark-ingest-write:${benchmark.id}`,
        severity: "warn",
        category: "data",
        title: `${benchmark.label}: benchmark observation write failed`,
        detail: error.message,
      }, svc).catch(() => {});
      return;
    }
  }

  // Still behind the book after taking the freshest provider: say so, because
  // the chart now truncates its comparison window to this benchmark.
  const newest = newestBarDate(best.candles);
  if (expectedSession && newest && newest < expectedSession) {
    await reportIssue({
      issueKey: `benchmark-stale:${benchmark.id}`,
      severity: "warn",
      category: "data",
      title: `${benchmark.label} benchmark is stale (${newest} vs book ${expectedSession})`,
      detail: `Freshest of ${usable.map((a) => `${a.provider}=${newestBarDate(a.candles) ?? "none"}`).join(", ")} for ${symbol}. Comparisons against this benchmark are truncated to ${newest}; the portfolio's own return is unaffected.`,
    }, svc).catch(() => {});
  }
}

async function loadBenchmarkLevels(svc: any, benchmark: BenchmarkConfig): Promise<LevelPoint[]> {
  const { data, error } = await svc
    .from("benchmark_price_observations")
    .select("date, close")
    .eq("benchmark_id", benchmark.id)
    .eq("source_status", "ok")
    .order("date", { ascending: true })
    .limit(500);
  if (error) return [];
  return (data ?? []).map((r: any) => ({ date: String(r.date).slice(0, 10), level: Number(r.close) }));
}

async function loadPaperSeries(svc: any, market: "us" | "india"): Promise<LevelPoint[]> {
  const { data, error } = await svc
    .from("paper_performance")
    .select("date, nav")
    .eq("market", market)
    .order("date", { ascending: true })
    .limit(500);
  if (error) throw new Error(`paper_performance read failed for ${market}: ${error.message}`);
  return (data ?? []).map((r: any) => asLevel(r, "nav"));
}

async function loadLiveSeries(svc: any, market: "us" | "india", currency: "USD" | "INR"): Promise<{ levels: LevelPoint[]; missingProvenance: boolean }> {
  const { data, error } = await svc
    .from("live_performance")
    .select("date, equity, market, currency, book_scope")
    .eq("market", market)
    .eq("currency", currency)
    .eq("book_scope", "all_live_accounts")
    .order("date", { ascending: true })
    .limit(1000);
  if (error) return { levels: [], missingProvenance: true };
  const sums = new Map<string, number>();
  for (const r of (data ?? []) as any[]) {
    const equity = Number(r.equity);
    if (!Number.isFinite(equity) || equity <= 0) continue;
    const date = String(r.date).slice(0, 10);
    sums.set(date, (sums.get(date) ?? 0) + equity);
  }
  return {
    levels: [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, level]) => ({ date, level })),
    missingProvenance: false,
  };
}

async function buildScorecards(svc: any) {
  const benchmarks = await loadBenchmarks(svc);
  const rows: any[] = [];
  const asOf = new Date().toISOString().slice(0, 10);

  // The session the BOOK has reached, per market. A secondary benchmark that
  // cannot reach this date truncates every comparison drawn against it, so it
  // is the right yardstick for "stale" — not a fixed number of days, which would
  // fire on weekends and holidays.
  const latestBookSession = new Map<string, string | null>();
  for (const market of MARKETS) {
    const { data } = await svc.from("paper_performance")
      .select("date").eq("market", market).eq("snapshot_type", "eod")
      .order("date", { ascending: false }).limit(1).maybeSingle();
    latestBookSession.set(market, data?.date ? String(data.date).slice(0, 10) : null);
  }

  for (const benchmark of benchmarks) {
    await upsertPaperObservations(svc, benchmark);
    await upsertLiveObservations(svc, benchmark);
    await upsertProviderObservations(svc, benchmark, latestBookSession.get(benchmark.market) ?? null);
  }

  for (const market of MARKETS) {
    const currency = CURRENCY[market];
    const marketBenchmarks = benchmarks.filter((b) => b.market === market);
    const paper = await loadPaperSeries(svc, market);
    const live = await loadLiveSeries(svc, market, currency);

    for (const benchmark of marketBenchmarks) {
      const benchmarkLevels = await loadBenchmarkLevels(svc, benchmark);
      const paperAsOf = latestAsOf([...paper, ...benchmarkLevels]);
      const liveAsOf = latestAsOf([...live.levels, ...benchmarkLevels]);
      for (const horizon of BENCHMARK_HORIZONS) {
        rows.push(computeBenchmarkScorecardRow({
          market,
          currency,
          book: "paper",
          bookScope: "market_paper_pool",
          benchmark,
          horizon,
          asOf: paperAsOf || asOf,
          portfolio: paper,
          benchmarkLevels,
          unavailableStatus: benchmarkLevels.length ? undefined : "benchmark_unpriceable",
          missingReason: benchmarkLevels.length ? undefined : "No price observations for benchmark",
        }));
        rows.push(computeBenchmarkScorecardRow({
          market,
          currency,
          book: "live",
          bookScope: "all_live_accounts",
          benchmark,
          horizon,
          asOf: liveAsOf || asOf,
          portfolio: live.levels,
          benchmarkLevels,
          unavailableStatus: live.missingProvenance
            ? "insufficient_data"
            : live.levels.length === 0
              ? "book_series_missing"
              : benchmarkLevels.length === 0
                ? "benchmark_unpriceable"
                : undefined,
          missingReason: live.missingProvenance
            ? "live_performance provenance missing"
            : live.levels.length === 0
              ? "No live equity series for this market/book scope"
              : benchmarkLevels.length === 0
                ? "No price observations for benchmark"
                : undefined,
        }));
      }
    }
  }

  if (rows.length) {
    // Coverage is observations / EXPECTED trading days, and the expectation is a
    // 5/7 calendar approximation — so a full window legitimately overshoots
    // (US 1M reported 104.5%). Coverage above 100% is not a real signal; clamp
    // it so the displayed number cannot claim more sessions than exist.
    const payload = rows.map((r) => ({
      ...r,
      coverage_pct: r.coverage_pct == null ? null : Math.min(100, r.coverage_pct),
      updated_at: new Date().toISOString(),
    }));
    const { error } = await svc.from("benchmark_scorecard").upsert(payload, {
      onConflict: "market,currency,book,book_scope,benchmark_id,horizon,as_of",
    });
    if (error) throw new Error(`benchmark_scorecard upsert failed: ${error.message}`);
  }

  return rows;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const url = new URL(req.url);
  const market = url.searchParams.get("market");
  const book = url.searchParams.get("book");
  let q = svc
    .from("benchmark_scorecard")
    .select("*")
    .order("as_of", { ascending: false })
    .order("horizon", { ascending: true })
    .limit(100);
  if (market === "us" || market === "india") q = q.eq("market", market);
  if (book === "paper" || book === "live") q = q.eq("book", book);
  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwnerOrCron(req);
  if (gate) return gate;
  try {
    const svc = createServiceClient();
    const rows = await buildScorecards(svc);
    return NextResponse.json({
      ok: true,
      rows_written: rows.length,
      statuses: rows.reduce((acc: Record<string, number>, row: any) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "benchmark_scorecard_failed" }, { status: 500 });
  }
}
