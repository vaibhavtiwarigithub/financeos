import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { assessMacroIndicators, MACRO_INDICATOR_UNIVERSE } from "@/lib/data/macro-regime-integrity";

export const dynamic = "force-dynamic";

const INDIA_FACTOR_SERIES = ["nifty50_close", "india_vix", "usdinr_spot", "brent_front"] as const;
const EXPOSURE_METHOD = "asof4d_v2";

/**
 * Owner-only, persisted-data read for Learning. This is context and historical
 * exposure, not a forecast. It makes no provider calls and writes nothing.
 */
export async function GET(request: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const market = request.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: regimeRuns, error: regimeRunsError, count: regimeRunCount } = await svc
    .from("market_regime_runs")
    .select("id,market,domestic_state,global_spillover_state,formula_version,computed_at,eligible_input_count", { count: "exact" })
    .eq("market", market)
    .order("computed_at", { ascending: false })
    .limit(30);
  if (regimeRunsError) return NextResponse.json({ error: regimeRunsError.message }, { status: 500 });

  let usRegime: Record<string, unknown> | null = null;
  if (market === "us") {
    const { data, error } = await svc.from("macro_regime")
      .select("week_of,regime,danger_score,summary,raw_indicators,created_at")
      .order("week_of", { ascending: false }).limit(1).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (data) {
      const integrity = assessMacroIndicators((data as any).raw_indicators);
      usRegime = {
        weekOf: (data as any).week_of,
        regime: (data as any).regime,
        dangerScore: (data as any).danger_score == null || !Number.isFinite(Number((data as any).danger_score)) ? null : Number((data as any).danger_score),
        createdAt: (data as any).created_at,
        summary: (data as any).summary,
        indicatorsAvailable: integrity.indicatorsAvailable,
        indicatorsExpected: MACRO_INDICATOR_UNIVERSE,
        dataUsable: integrity.usable,
        unavailableReason: integrity.reason,
      };
    }
  }

  let indiaFactors: Array<{ series: string; asOf: string; value: number; source: string }> = [];
  let indiaExposures: Array<Record<string, unknown>> = [];
  let exposureCoverage: { ok: number; insufficient: number; latestWindowEnd: string | null } | null = null;
  if (market === "india") {
    const [{ data: factors, error: factorError }, { data: exposureRows, error: exposureError }] = await Promise.all([
      svc.from("india_macro_observations").select("series_id,source,obs_date,value")
        .in("series_id", [...INDIA_FACTOR_SERIES]).order("obs_date", { ascending: false }).limit(500),
      svc.from("india_macro_exposures").select("symbol,window_start,window_end,n_obs,factor_coverage,status,r2,betas,tstats,significant,method")
        .eq("method", EXPOSURE_METHOD).order("window_end", { ascending: false }).limit(1000),
    ]);
    if (factorError) return NextResponse.json({ error: factorError.message }, { status: 500 });
    if (exposureError) return NextResponse.json({ error: exposureError.message }, { status: 500 });

    const latestBySeries = new Map<string, any>();
    for (const row of factors ?? []) {
      if (!latestBySeries.has(String((row as any).series_id))) latestBySeries.set(String((row as any).series_id), row);
    }
    indiaFactors = [...latestBySeries.entries()].map(([series, row]) => ({
      series,
      asOf: String((row as any).obs_date),
      value: Number((row as any).value),
      source: String((row as any).source),
    })).filter((row) => Number.isFinite(row.value)).sort((a, b) => a.series.localeCompare(b.series));

    const latestBySymbol = new Map<string, any>();
    for (const row of exposureRows ?? []) {
      const symbol = String((row as any).symbol ?? "").toUpperCase();
      if (symbol && !latestBySymbol.has(symbol)) latestBySymbol.set(symbol, row);
    }
    indiaExposures = [...latestBySymbol.values()].map((row: any) => ({
      symbol: String(row.symbol).toUpperCase(),
      windowStart: row.window_start,
      windowEnd: row.window_end,
      observations: Number(row.n_obs),
      factorCoverage: Number(row.factor_coverage),
      status: row.status,
      r2: row.r2 == null ? null : Number(row.r2),
      betas: row.betas ?? {},
      tstats: row.tstats ?? {},
      significant: Array.isArray(row.significant) ? row.significant : [],
    })).sort((a: any, b: any) => a.symbol.localeCompare(b.symbol));
    exposureCoverage = {
      ok: indiaExposures.filter((row: any) => row.status === "ok").length,
      insufficient: indiaExposures.filter((row: any) => row.status !== "ok").length,
      latestWindowEnd: indiaExposures.map((row: any) => String(row.windowEnd ?? "")).sort().pop() || null,
    };
  }

  return NextResponse.json({
    market,
    asOf: new Date().toISOString(),
    shadowOnly: true,
    historicalAnalog: {
      implemented: false,
      regimeRunCount: regimeRunCount ?? 0,
      latestRegimeRun: regimeRuns?.[0] ?? null,
      reason: "No validated historical-episode matcher currently produces symbol-level forward-return evidence.",
    },
    usRegime,
    indiaFactors,
    indiaExposureCoverage: exposureCoverage,
    indiaExposures,
  });
}
