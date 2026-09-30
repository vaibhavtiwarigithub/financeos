import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getShadowProgramStatuses } from "@/lib/shadows/status";
import { summarizeAttribution } from "@/lib/shadows/summary";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const market = req.nextUrl.searchParams.get("market");
  if (market !== "us" && market !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }

  const svc = createServiceClient();
  const programs = await getShadowProgramStatuses(svc, market);
  const producerRunResult = await svc.rpc("get_upgrade_path_producer_runs_latest", { p_market: market });
  const latestProducerRuns = new Map<string, any>();
  for (const row of producerRunResult.data ?? []) {
    if (!latestProducerRuns.has(String(row.program_id))) latestProducerRuns.set(String(row.program_id), row);
  }
  const snapshotResult = await svc.rpc("get_upgrade_path_shadow_book_latest", { p_market: market });
  const snapshotLedger = snapshotResult.error
    ? { state: "unavailable" as const, reason: "Forward shadow-book snapshot ledger is unavailable; no P&L snapshot is shown." }
    : { state: "available" as const, reason: null };
  const snapshots = new Map<string, any>((snapshotResult.data ?? []).map((row: any) => [String(row.program_id), row]));
  const programsWithSnapshots = programs.map((program) => {
    const producerRun = producerRunResult.error
      ? { state: "unavailable" as const, note: "Producer-run health ledger is unavailable; collector liveness cannot be verified." }
      : latestProducerRuns.has(program.id)
        ? (() => {
          const row = latestProducerRuns.get(program.id);
          const staleRunning = row.status === "running" && Date.now() - Date.parse(row.started_at) > 15 * 60_000;
          return { ...row, state: staleRunning ? "stale" as const : row.status as string };
        })()
        : { state: program.attribution.state === "producer_missing" ? "not_registered" as const : "no_run" as const, note: "No persisted producer invocation is recorded for this program and market." };
    if (program.attribution.comparisonType === "operational_only") {
      return { ...program, producerRun, shadowBookSnapshot: { state: "not_attributable" as const, note: "Operational-only path; no portfolio-return snapshot is appropriate." } };
    }
    if (snapshotLedger.state === "unavailable") {
      return { ...program, producerRun, shadowBookSnapshot: { state: "unavailable" as const, note: snapshotLedger.reason } };
    }
    const row = snapshots.get(program.id);
    if (!row || row.market !== market) {
      return { ...program, producerRun, shadowBookSnapshot: { state: "none" as const, note: "No forward paired-book P&L snapshot has been captured for this program." } };
    }
    const snapshot = {
      state: "captured" as const,
      sessionDate: row.session_date,
      windowStart: row.window_start,
      programVersion: row.program_version,
      baselineVersion: row.baseline_version,
      baselineReturnPct: Number(row.baseline_cumulative_return_pct),
      variantReturnPct: Number(row.variant_cumulative_return_pct),
      benchmarkReturnPct: Number(row.benchmark_cumulative_return_pct),
      netDeltaPct: Number(row.net_incremental_return_pct),
      benchmarkRelativeDeltaPct: Number(row.benchmark_relative_incremental_return_pct),
      baselineDrawdownPct: Number(row.baseline_drawdown_pct),
      variantDrawdownPct: Number(row.variant_drawdown_pct),
      turnoverPct: Number(row.turnover_pct),
      independentBlocks: Number(row.independent_blocks),
      blockers: Array.isArray(row.blockers) ? row.blockers.map(String) : [],
    };
    if (program.id === "exit-stop-shadow" && program.attribution.state === "producer_missing") {
      const blocks = snapshot.independentBlocks;
      const canStillCollect = Number.isFinite(blocks) && blocks < 2;
      const attribution = {
        ...program.attribution,
        state: canStillCollect ? "collecting" as const : "invalid" as const,
        asOfSession: String(row.session_date),
        windowStart: String(row.window_start),
        reason: canStillCollect
          ? `Paired US book snapshots are collecting: ${Math.max(0, blocks)}/2 complete non-overlapping 10-session blocks; no attribution row is reported before both arms have enough blocks.`
          : "The persisted paired book has enough blocks for attribution, but its immutable attribution row is missing. Treat this as a producer/write failure, not as a measured result.",
      };
      return { ...program, producerRun, attribution, benefitVerdict: "insufficient" as const, benefitEvidence: attribution.reason, shadowBookSnapshot: snapshot };
    }
    return {
      ...program,
      producerRun,
      shadowBookSnapshot: snapshot,
    };
  });
  const trackedCalls = programs.reduce((sum, program) =>
    sum + (program.calls.mode === "tracked" ? program.calls.recorded ?? 0 : 0), 0);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    build: {
      environment: process.env.VERCEL_ENV ?? "local",
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? null,
    },
    summary: {
      total: programs.length,
      collecting: programs.filter((program) => program.lifecycle === "collecting" || program.lifecycle === "paper_active").length,
      readyForReview: programs.filter((program) => program.lifecycle === "ready_for_review").length,
      blockedOrIdle: programs.filter((program) => ["blocked", "idle", "off"].includes(program.lifecycle)).length,
      trackedCalls7d: trackedCalls,
      attribution: summarizeAttribution(programsWithSnapshots),
    },
    market,
    snapshotLedger,
    programs: programsWithSnapshots,
  });
}
