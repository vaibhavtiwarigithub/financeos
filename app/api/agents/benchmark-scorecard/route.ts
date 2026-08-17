import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
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
  const query = (columns: string) => svc
    .from("paper_performance")
    .select(columns)
    .eq("market", benchmark.market)
    .not("bench_nav", "is", null)
    .order("date", { ascending: true })
    .limit(500);
  let { data, error } = await query("date, bench_nav, bench_session_date, bench_source");
  // The migration is intentionally not assumed to be applied yet.
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
        source_status: !(Number(r.bench_nav) > 0) ? "missing"
          : session != null && session !== date ? "unpriceable"
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

  for (const benchmark of benchmarks) {
    await upsertPaperObservations(svc, benchmark);
    await upsertLiveObservations(svc, benchmark);
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
