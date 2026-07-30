import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadTradingMandate } from "@/lib/trading-mandate";
import {
  annotateEarningsRisk,
  fetchRobinhoodUpcomingEarnings,
  recordEarningsRiskObservation,
  tradingSessionsBetween,
} from "@/lib/risk/earnings-risk";
import {
  buildEarningsHoldingTargets,
  filterTargetsForCachedEvents,
} from "@/lib/risk/earnings-holding-targets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function usMarketDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

async function latestLiveHoldingRows(supabase: any): Promise<any[]> {
  const { data: runs } = await supabase
    .from("holding_risk_runs")
    .select("id,account_id,completed_at")
    .eq("market", "us")
    .eq("status", "complete")
    .order("completed_at", { ascending: false })
    .limit(50);
  const latestByAccount = new Map<string, string>();
  for (const run of runs ?? []) {
    const account = String((run as any).account_id ?? "");
    if (account && !latestByAccount.has(account)) latestByAccount.set(account, String((run as any).id));
  }
  const runIds = [...latestByAccount.values()];
  if (runIds.length === 0) return [];
  const { data } = await supabase
    .from("holding_risk_snapshots")
    .select("run_id,symbol,current_price,source_captured_at")
    .in("run_id", runIds);
  return data ?? [];
}

export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const supabase = createServiceClient();
  const startedAt = new Date().toISOString();
  const { data: run } = await supabase.from("agent_runs").insert({
    agent_type: "earnings_risk_monitor",
    market: "us",
    status: "running",
    trigger_source: isCron ? "scheduled" : "manual",
    started_at: startedAt,
  } as any).select("id").maybeSingle();

  try {
    const mandate = await loadTradingMandate(supabase, "us");
    const [{ data: paperPositions }, liveSnapshots] = await Promise.all([
      supabase.from("paper_positions")
        .select("symbol,current_price,stop_loss,resolved_horizon_days")
        .eq("market", "us")
        .eq("position_role", "alpha")
        .gt("qty", 0)
        .limit(50),
      latestLiveHoldingRows(supabase),
    ]);
    const targets = buildEarningsHoldingTargets({
      paperPositions: paperPositions ?? [],
      liveSnapshots,
      defaultHorizonSessions: mandate.target_hold_days,
      maxPerEnvironment: 30,
    });
    const today = usMarketDay(new Date());
    const through = new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const symbols = [...new Set(targets.map(target => target.symbol))];
    const [{ data: calendarRows }, robinhoodEvents] = await Promise.all([
      symbols.length
        ? supabase.from("earnings_calendar")
          .select("symbol,report_date")
          .eq("market", "us")
          .in("symbol", symbols)
          .gte("report_date", today)
          .lte("report_date", through)
          .order("report_date", { ascending: true })
        : Promise.resolve({ data: [] as any[] }),
      symbols.length ? fetchRobinhoodUpcomingEarnings().catch(() => []) : Promise.resolve([]),
    ]);
    const nextEventBySymbol = new Map<string, string>();
    // Prefer the persisted PIT calendar when both exist; Robinhood fills cache
    // misses with a single batch calendar read rather than N symbol calls.
    for (const event of [...(calendarRows ?? []), ...robinhoodEvents]) {
      const symbol = String((event as any).symbol ?? "").toUpperCase();
      const reportDate = String((event as any).report_date ?? (event as any).reportDate ?? "");
      if (symbol && !nextEventBySymbol.has(symbol)) {
        nextEventBySymbol.set(symbol, reportDate);
      }
    }
    // Per-symbol provider calls are admitted only for an event discovered by
    // the PIT cache or one bounded Robinhood calendar read.
    const relevantTargets = filterTargetsForCachedEvents(
      targets,
      nextEventBySymbol,
      reportDate => tradingSessionsBetween("us", today, reportDate),
    );

    let measured = 0;
    let relevantEvents = 0;
    let usableMoveProxies = 0;
    const unavailable: string[] = [];
    const batchSize = 3;
    for (let index = 0; index < relevantTargets.length; index += batchSize) {
      const batch = relevantTargets.slice(index, index + batchSize);
      await Promise.all(batch.map(async target => {
        try {
          const annotation = await annotateEarningsRisk({
            supabase,
            symbol: target.symbol,
            market: "us",
            horizonSessions: target.horizonSessions,
            spot: target.spot,
            stopDistancePct: target.stopDistancePct,
          });
          const sessions = annotation.event.sessionsUntilReport;
          if (annotation.event.status === "available" && sessions != null
              && sessions >= 0 && sessions <= target.horizonSessions) relevantEvents++;
          if (annotation.moveProxy?.quality === "usable") usableMoveProxies++;
          await recordEarningsRiskObservation(supabase, {
            environment: target.environment,
            decisionKind: "holding",
            annotation,
          });
          measured++;
        } catch {
          unavailable.push(`${target.environment}:${target.symbol}`);
        }
      }));
      if (index + batchSize < relevantTargets.length) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }

    const resultSummary = `US holding earnings-risk shadow: ${measured}/${relevantTargets.length} relevant holdings measured (${targets.length} total holdings), ${usableMoveProxies} usable move proxies, ${unavailable.length} unavailable. No behavior changed.`;
    if ((run as any)?.id) {
      await supabase.from("agent_runs").update({
        status: "done",
        completed_at: new Date().toISOString(),
        result_summary: resultSummary,
      } as any).eq("id", (run as any).id);
    }
    return NextResponse.json({
      success: true,
      market: "us",
      behaviorChanged: false,
      holdings: targets.length,
      relevantTargets: relevantTargets.length,
      measured,
      relevantEvents,
      usableMoveProxies,
      unavailable,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    if ((run as any)?.id) {
      await supabase.from("agent_runs").update({
        status: "error",
        completed_at: new Date().toISOString(),
        result_summary: message.slice(0, 500),
      } as any).eq("id", (run as any).id);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
