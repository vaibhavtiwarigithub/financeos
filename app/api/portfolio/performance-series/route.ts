// Portfolio performance series — read API for the multi-timeframe benchmark chart.
//
// GET /api/portfolio/performance-series?market=us|india&benchmarkId=<uuid>
//   → enabled market benchmarks, selected display benchmark and an exact-session
//     joined series ordered by date ascending.
// PATCH { market, benchmarkId } persists the owner's market-local DISPLAY
// default. It never changes benchmarks.is_primary (the governed learning target).
//
// Owner/auth-gated before using the server-only service client. `nav` is this
// market's paper NAV; comparator levels come from the benchmark observation
// ledger. Rebasing to % return per timeframe is done client-side.

import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import {
  mergePortfolioBenchmarkSeries,
  selectDisplayBenchmark,
  type DisplayBenchmark,
} from "@/lib/analytics/benchmark-display";

export const dynamic = "force-dynamic";

type Market = "us" | "india";

function preferenceKey(market: Market) {
  return `portfolio_default_benchmark_${market}`;
}

function isMarket(value: unknown): value is Market {
  return value === "us" || value === "india";
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const marketParam = req.nextUrl.searchParams.get("market");
  if (!isMarket(marketParam)) {
    return NextResponse.json({ error: "invalid_market: expected market=us|india" }, { status: 400 });
  }
  const market = marketParam;
  const svc = createServiceClient();

  const [{ data: benchmarkRows, error: benchmarkError }, { data: preference, error: preferenceError }] = await Promise.all([
    svc.from("benchmarks")
      .select("id, label, symbol, provider_symbol, is_primary")
      .eq("market", market)
      .eq("enabled", true)
      .order("is_primary", { ascending: false })
      .order("label", { ascending: true }),
    svc.from("app_settings").select("value").eq("key", preferenceKey(market)).maybeSingle(),
  ]);
  if (benchmarkError) return NextResponse.json({ error: benchmarkError.message }, { status: 500 });
  if (preferenceError) return NextResponse.json({ error: preferenceError.message }, { status: 500 });

  const benchmarks = (benchmarkRows ?? []) as DisplayBenchmark[];
  const selected = selectDisplayBenchmark(
    benchmarks,
    req.nextUrl.searchParams.get("benchmarkId"),
    preference?.value ?? null,
  );
  if (!selected) {
    return NextResponse.json({ error: `no_enabled_benchmarks:${market}` }, { status: 503 });
  }

  const [{ data: portfolioRows, error: portfolioError }, { data: observationRows, error: observationError }] = await Promise.all([
    svc.from("paper_performance")
      .select("date, nav, bench_nav")
      .eq("market", market)
      .order("date", { ascending: true })
      .limit(1000),
    svc.from("benchmark_price_observations")
      .select("date, close")
      .eq("benchmark_id", selected.id)
      .eq("source_status", "ok")
      .order("date", { ascending: true })
      .limit(1000),
  ]);
  if (portfolioError) return NextResponse.json({ error: portfolioError.message }, { status: 500 });
  if (observationError) return NextResponse.json({ error: observationError.message }, { status: 500 });

  let levels = (observationRows ?? []).map((row: any) => ({ date: String(row.date), close: row.close == null ? null : Number(row.close) }));
  // The primary ledger predates benchmark_price_observations. Preserve an
  // honest fallback while old deployments/backfills catch up; secondary rows
  // never use paper_performance.bench_nav because it contains the primary only.
  if (!levels.length && selected.is_primary) {
    levels = (portfolioRows ?? []).map((row: any) => ({
      date: String(row.date),
      close: row.bench_nav == null ? null : Number(row.bench_nav),
    }));
  }
  const series = mergePortfolioBenchmarkSeries(
    (portfolioRows ?? []).map((row: any) => ({ date: String(row.date), nav: row.nav == null ? null : Number(row.nav) })),
    levels,
  );

  return NextResponse.json({
    market,
    benchmarks,
    selected_benchmark: selected,
    series,
    benchmark_status: levels.length ? "ok" : "unavailable",
  });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isMarket(body?.market) || typeof body?.benchmarkId !== "string") {
    return NextResponse.json({ error: "market_and_benchmarkId_required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: benchmark, error: benchmarkError } = await svc.from("benchmarks")
    .select("id")
    .eq("id", body.benchmarkId)
    .eq("market", body.market)
    .eq("enabled", true)
    .maybeSingle();
  if (benchmarkError) return NextResponse.json({ error: benchmarkError.message }, { status: 500 });
  if (!benchmark) return NextResponse.json({ error: "benchmark_not_enabled_for_market" }, { status: 400 });

  const { error } = await svc.from("app_settings").upsert({
    key: preferenceKey(body.market),
    value: body.benchmarkId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, market: body.market, benchmarkId: body.benchmarkId });
}
