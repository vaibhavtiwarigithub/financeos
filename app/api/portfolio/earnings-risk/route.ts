import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { tradingSessionsBetween } from "@/lib/risk/earnings-risk";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const market = req.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "invalid_market" }, { status: 400 });
  }
  const gate = await requireOwner();
  if (gate) return gate;
  const supabase = await createClient();

  const [{ data: runs }, { data: observations }] = await Promise.all([
    supabase.from("holding_risk_runs")
      .select("id,account_id,captured_on,completed_at")
      .eq("market", market)
      .eq("status", "complete")
      .order("captured_on", { ascending: false })
      .order("completed_at", { ascending: false })
      .limit(100),
    supabase.from("earnings_risk_observations")
      .select("symbol,environment,decision_kind,observed_at,report_date,report_session,sessions_until_report,earnings_status,earnings_source,earnings_confidence,options_source,options_quality,expiry,quote_as_of,move_proxy_pct,stop_distance_pct,stop_to_move_ratio,counterfactual_verdict,counterfactual_reason,legacy_gate_blocked")
      .eq("market", market)
      .order("observed_at", { ascending: false })
      .limit(500),
  ]);

  const latestRunIds: string[] = [];
  const seenAccounts = new Set<string>();
  for (const run of runs ?? []) {
    if (!seenAccounts.has(run.account_id)) {
      seenAccounts.add(run.account_id);
      latestRunIds.push(run.id);
    }
  }
  const { data: snapshots } = latestRunIds.length
    ? await supabase.from("holding_risk_snapshots").select("symbol").in("run_id", latestRunIds)
    : { data: [] as Array<{ symbol: string }> };
  const symbols = [...new Set((snapshots ?? []).map((row) => row.symbol).filter(Boolean))];
  const today = new Date().toISOString().slice(0, 10);
  const { data: calendar } = symbols.length
    ? await supabase.from("earnings_calendar")
        .select("symbol,report_date,report_time,announcement_session,fetched_at")
        .eq("market", market)
        .in("symbol", symbols)
        .gte("report_date", today)
        .order("report_date", { ascending: true })
    : { data: [] as any[] };

  const latestBySymbol = new Map<string, any>();
  for (const row of observations ?? []) {
    if (!latestBySymbol.has(row.symbol)) latestBySymbol.set(row.symbol, row);
  }
  const calendarBySymbol = new Map<string, any>();
  for (const row of calendar ?? []) {
    if (!calendarBySymbol.has(row.symbol)) calendarBySymbol.set(row.symbol, row);
  }
  const holdings = symbols.map((symbol) => {
    const observed = latestBySymbol.get(symbol);
    const event = calendarBySymbol.get(symbol);
    const reportDate = observed?.report_date ?? event?.report_date ?? null;
    return {
      symbol,
      reportDate,
      reportSession: observed?.report_session ?? event?.announcement_session ?? event?.report_time ?? "unknown",
      sessionsUntilReport: reportDate ? tradingSessionsBetween(market, today, reportDate) : null,
      earningsStatus: observed?.earnings_status ?? (reportDate ? "available" : "unknown"),
      earningsSource: observed?.earnings_source ?? (event ? "earnings_calendar_cache" : null),
      optionsSource: market === "us" ? observed?.options_source ?? null : null,
      optionsQuality: market === "us" ? observed?.options_quality ?? "unavailable" : "unavailable",
      expiry: observed?.expiry ?? null,
      quoteAsOf: observed?.quote_as_of ?? null,
      moveProxyPct: observed?.move_proxy_pct ?? null,
      stopDistancePct: observed?.stop_distance_pct ?? null,
      stopToMoveRatio: observed?.stop_to_move_ratio ?? null,
      observedAt: observed?.observed_at ?? event?.fetched_at ?? null,
    };
  }).sort((a, b) =>
    (a.sessionsUntilReport ?? Number.MAX_SAFE_INTEGER) - (b.sessionsUntilReport ?? Number.MAX_SAFE_INTEGER));

  const entries = (observations ?? []).filter((row) => row.decision_kind === "entry");
  return NextResponse.json({
    market,
    policyMode: "shadow",
    behaviorChanged: false,
    holdings,
    measurement: {
      entryDecisions: entries.length,
      distinctEvents: new Set(entries.filter((row) => row.report_date).map((row) => `${row.symbol}:${row.report_date}`)).size,
      usableMoveProxies: entries.filter((row) => row.options_quality === "usable").length,
      legacyGateBlocks: entries.filter((row) => row.legacy_gate_blocked).length,
      requiredEntryDecisions: 60,
      requiredDistinctEvents: 20,
    },
  });
}
