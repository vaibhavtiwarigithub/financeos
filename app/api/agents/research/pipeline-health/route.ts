import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";

// Sources that count as "discovery" — screener candidates and thematic baskets.
// Holding re-scores and pure watchlist do NOT count as new pipeline inflow.
const DISCOVERY_SOURCES = new Set([
  "screener_momentum",
  "screener_value",
  "edge_relative_strength",
  "metals_basket",
  "region_etf",
  "india_screener",
]);

// One row per (date, market). Aggregates across all research runs that day.
export type PipelineHealthRow = {
  date: string;          // YYYY-MM-DD
  market: string;        // "us" | "india"
  runs: number;          // how many agent_run rows fired
  queue: number;         // total symbols entering the day's pipeline
  holdings: number;      // holding re-scores
  candidates: number;    // watchlist + discovery scored
  deferred: number;      // budget-cut in first (main) run
  budget_pressure_pct: number; // deferred / queue * 100 (first-run pressure)
  signals: number;       // total decisions recorded
  discovery: number;     // screener-sourced obs that hit decision_observations
  watchlist: number;     // watchlist-sourced obs
  discovery_gap: "ok" | "low" | "zero"; // health flag
};

export async function GET(req: NextRequest) {
  // Allow cron or authenticated user.
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const market = url.searchParams.get("market") ?? "us";
  const days = Math.min(90, parseInt(url.searchParams.get("days") ?? "30", 10));
  const svc = createServiceClient();

  // --- 1. Agent-run aggregates (budget / throughput) ---
  const { data: runs, error: runsErr } = await svc
    .from("agent_runs")
    .select("completed_at, signals_written, status, workload_metrics")
    .eq("agent_type", "research")
    .eq("market", market)
    .gte("completed_at", new Date(Date.now() - days * 86400_000).toISOString())
    .order("completed_at", { ascending: false });

  if (runsErr) return NextResponse.json({ error: runsErr.message }, { status: 500 });

  // --- 2. Discovery-source breakdown from decision_observations ---
  const { data: obs, error: obsErr } = await svc
    .from("decision_observations")
    .select("ts, discovery_source")
    .eq("market", market)
    .gte("ts", new Date(Date.now() - days * 86400_000).toISOString());

  if (obsErr) return NextResponse.json({ error: obsErr.message }, { status: 500 });

  // --- Aggregate by date ---

  // decision_observations grouped by date → discovery/watchlist/holding counts
  const obsByDate: Record<string, { discovery: number; watchlist: number; holding: number }> = {};
  for (const row of obs ?? []) {
    const d = String(row.ts).slice(0, 10);
    if (!obsByDate[d]) obsByDate[d] = { discovery: 0, watchlist: 0, holding: 0 };
    const src = String(row.discovery_source ?? "");
    if (DISCOVERY_SOURCES.has(src)) obsByDate[d].discovery++;
    else if (src === "watchlist" || src === "carry_forward") obsByDate[d].watchlist++;
    else obsByDate[d].holding++; // "holding", "india_holding", "manual", etc.
  }

  // agent_runs grouped by date → runs, queue, holdings, candidates, deferred, signals
  // Within a day, the FIRST run typically has the most deferred (highest budget pressure).
  // We use max(deferred) across runs to represent first-run pressure rather than sum
  // (second runs are sweep passes with smaller queues).
  const runsByDate: Record<string, {
    runCount: number; maxDeferred: number; sumQueue: number;
    sumHoldings: number; sumCandidates: number; sumSignals: number;
  }> = {};

  for (const row of (runs ?? []).slice().reverse()) {
    const d = String(row.completed_at).slice(0, 10);
    const wm = (row.workload_metrics as any) ?? {};
    const holding = Number(wm.holding_processed ?? 0);
    const candidate = Number(wm.candidate_processed ?? 0);
    const deferred = Number(wm.deferred ?? 0);
    // queue_depth_start is null on older runs; fall back to holding+candidate+deferred.
    const queue = Number(wm.queue_depth_start ?? (holding + candidate + deferred));

    if (!runsByDate[d]) {
      runsByDate[d] = { runCount: 0, maxDeferred: 0, sumQueue: 0, sumHoldings: 0, sumCandidates: 0, sumSignals: 0 };
    }
    const slot = runsByDate[d];
    slot.runCount++;
    slot.maxDeferred = Math.max(slot.maxDeferred, deferred);
    slot.sumQueue += queue;
    slot.sumHoldings += holding;
    slot.sumCandidates += candidate;
    slot.sumSignals += Number(row.signals_written ?? 0);
  }

  // Merge into final rows
  const allDates = new Set([...Object.keys(obsByDate), ...Object.keys(runsByDate)]);
  const rows: PipelineHealthRow[] = Array.from(allDates)
    .sort((a, b) => b.localeCompare(a))
    .map((date) => {
      const r = runsByDate[date] ?? { runCount: 0, maxDeferred: 0, sumQueue: 0, sumHoldings: 0, sumCandidates: 0, sumSignals: 0 };
      const o = obsByDate[date] ?? { discovery: 0, watchlist: 0, holding: 0 };
      // Budget pressure: deferred / first-run queue (sumQueue approximates this;
      // for multi-run days the first run's queue is largest so max deferred / sumQueue
      // is a lower bound — acceptable, it reads conservative).
      const pressure = r.sumQueue > 0 ? Math.round(r.maxDeferred / r.sumQueue * 100) : 0;
      const discGap: "ok" | "low" | "zero" = o.discovery === 0 ? "zero" : o.discovery < 5 ? "low" : "ok";
      return {
        date,
        market,
        runs: r.runCount,
        queue: r.sumQueue,
        holdings: r.sumHoldings,
        candidates: r.sumCandidates,
        deferred: r.maxDeferred,
        budget_pressure_pct: pressure,
        signals: r.sumSignals,
        discovery: o.discovery,
        watchlist: o.watchlist,
        discovery_gap: discGap,
      };
    });

  return NextResponse.json({ rows, market, days });
}
