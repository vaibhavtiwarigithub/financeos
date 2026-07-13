// Portfolio performance series — read API for the multi-timeframe benchmark chart.
//
// GET /api/portfolio/performance-series?market=us|india
//   → { series: [{ date, nav, bench_nav }] } ordered by date ascending.
//
// Owner/auth-gated: uses the AUTHENTICATED user's Supabase client (same pattern
// as /api/portfolio/live-holdings and /api/portfolio/risk-daily). The
// `authenticated_only` RLS policy on paper_performance (migration 005) scopes
// the read. `nav` is this market's paper NAV; `bench_nav` is the benchmark index
// level for the same day (US = VOO, India = NIFTY ^NSEI) upserted daily by the
// position-monitor cron. Rebasing to % return per timeframe is done client-side.

import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();

  const marketParam = req.nextUrl.searchParams.get("market");
  if (marketParam !== "us" && marketParam !== "india") {
    return NextResponse.json({ error: "invalid_market: expected market=us|india" }, { status: 400 });
  }
  const market = marketParam;

  const { data, error } = await supabase
    .from("paper_performance")
    .select("date, nav, bench_nav")
    .eq("market", market)
    .order("date", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const series = (data ?? []).map((r: any) => ({
    date: r.date,
    nav: r.nav != null ? Number(r.nav) : null,
    bench_nav: r.bench_nav != null ? Number(r.bench_nav) : null,
  }));

  return NextResponse.json({ market, series });
}
