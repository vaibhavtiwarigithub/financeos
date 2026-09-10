import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { prewarmPriceCache } from "@/lib/chart-data";
import { resolvePrewarmScope, PREWARM_RECENT_DECISION_DAYS } from "@/lib/data/prewarm-scope";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/agents/price-prewarm?market=us|india
//
// PRICE-BAR refresh for the traded universe. Nothing else.
//
// THE DEFECT THIS EXISTS FOR. prewarmPriceCache was reachable from exactly ONE
// caller: the research cron, which runs PRE-CLOSE (13:00 UTC for US). But
// expectedNewestSession() — the rule the prewarm, the quote gate and the
// freshness monitor all share — only names today's session AFTER the close. So
// the pre-close run can never see the current session as missing: it reported
// "134/139 already fresh" while the monitor, running at 20:00 UTC, correctly
// reported 86/103 scopes stale. Between the close and kairos-position-monitor
// at 20:15 nothing refetched anything, so marks, stop checks and target checks
// ran against the PREVIOUS session's close. That is the failure
// lib/data/completed-candles.ts records from 2026-08-17: "let Friday's close be
// marked, stop-checked and target-checked as Monday's price for all 13 US
// positions." The detection was fixed then; the SCHEDULE never was.
//
// WHY NOT AN EXISTING ROUTE.
//  - /api/agents/prewarm is the EVIDENCE warmer: it calls prewarmSymbol and
//    fills av_cache with fundamentals/sentiment/insider. It touches no price
//    bars, and running it a second time each day would double the daily
//    Alpha Vantage / Massive / GDELT evidence load for no price benefit.
//  - /api/agents/price-cache-fill serves the Markets TILES: it filters Massive's
//    grouped-daily snapshot to a fixed 31-ETF regime/sector/leveraged list, and
//    its mostRecentWeekday() always steps back a calendar day, so it can neither
//    cover the traded universe nor fetch today.
//
// SCOPE IS THE SAME SET THE FRESHNESS CONTRACT DEMANDS — open positions, then
// today's recently-scored tail, then benchmarks — resolved through the shared
// resolvePrewarmScope so the monitor and the refresher cannot disagree again.
// There is no `batch` here because this route does not score anything.
//
// HARD CONTRACT: reads paper_positions and decision_observations, writes only
// price_cache. No scoring, no signals, no proposals, no broker or order path.

const BENCHMARK_SYMBOLS = ["VOO", "QQQ", "SPY", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLC", "XLP", "XLU", "XLRE", "XLB"];
const RESPONSE_RESERVE_MS = 5_000;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();

  let openPositions: string[] = [];
  let recentlyScored: string[] = [];
  try {
    const decisionSince = new Date(Date.now() - PREWARM_RECENT_DECISION_DAYS * 86400_000).toISOString();
    const [positionRows, decisionRows] = await Promise.all([
      svc.from("paper_positions").select("symbol")
        .eq("market", market).is("exit_reason", null).gt("qty", 0).limit(500),
      svc.from("decision_observations").select("symbol")
        .eq("market", market).gte("ts", decisionSince).limit(5000),
    ]);
    openPositions = (positionRows.data ?? []).map((r: any) => String(r.symbol ?? ""));
    recentlyScored = (decisionRows.data ?? []).map((r: any) => String(r.symbol ?? ""));
  } catch (e: any) {
    // Unlike the research cron, this route has nothing else to fall back to: an
    // empty scope would report a clean run having refreshed nothing.
    return NextResponse.json(
      { market, error: `prewarm scope resolution failed: ${e?.message ?? String(e)}` },
      { status: 503 },
    );
  }

  const symbols = resolvePrewarmScope({
    batch: [],
    benchmarks: market === "us" ? BENCHMARK_SYMBOLS : [],
    openPositions,
    recentlyScored,
  });

  if (symbols.length === 0) {
    return NextResponse.json({ market, symbols: 0, note: "no open positions or recent decisions in scope" });
  }

  const deadlineAt = startedAt + maxDuration * 1000 - RESPONSE_RESERVE_MS;
  let result;
  try {
    result = await prewarmPriceCache(symbols, svc, { deadlineAt });
  } catch (e: any) {
    return NextResponse.json(
      { market, symbols: symbols.length, error: `prewarm threw: ${e?.message ?? String(e)}` },
      { status: 500 },
    );
  }

  // Running out of budget is REPORTED, never hidden. A silent partial refresh is
  // exactly how the original freeze went unnoticed for 25 days. Symbols are
  // priority-ordered (positions first), so a partial run still refreshed the
  // bars that drive marks, stops and targets.
  const issueKey = `price-prewarm-incomplete:${market}`;
  if (result.skipped > 0 || result.failed > 0) {
    await reportIssue({
      issueKey,
      severity: "warn",
      category: "data",
      title: `Post-close price prewarm incomplete (${market.toUpperCase()}) — ${result.skipped + result.failed}/${symbols.length} not refreshed`,
      detail: `${result.ok} fetched, ${result.alreadyFresh} already fresh, ${result.failed} failed, ${result.skipped} skipped for time. Symbols left unrefreshed keep serving the PREVIOUS session's close, which is what position-monitor then marks, stop-checks and target-checks against. Scope is priority-ordered, so open positions were refreshed first.`,
      autoExpireAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    }, svc).catch(() => {});
  } else {
    await resolveIssue(issueKey, svc).catch(() => {});
  }

  return NextResponse.json({
    market,
    symbols: symbols.length,
    ...result,
    durationMs: Date.now() - startedAt,
  });
}
