import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getShadowProgramStatuses } from "@/lib/shadows/status";

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
  const snapshotResult = await svc.rpc("get_upgrade_path_shadow_book_latest", { p_market: market });
  const snapshotLedger = snapshotResult.error
    ? { state: "unavailable" as const, reason: "Forward shadow-book snapshot ledger is unavailable; no P&L snapshot is shown." }
    : { state: "available" as const, reason: null };
  const snapshots = new Map<string, any>((snapshotResult.data ?? []).map((row: any) => [String(row.program_id), row]));
  const programsWithSnapshots = programs.map((program) => {
    if (program.attribution.comparisonType === "operational_only") {
      return { ...program, shadowBookSnapshot: { state: "not_attributable" as const, note: "Operational-only path; no portfolio-return snapshot is appropriate." } };
    }
    if (snapshotLedger.state === "unavailable") {
      return { ...program, shadowBookSnapshot: { state: "unavailable" as const, note: snapshotLedger.reason } };
    }
    const row = snapshots.get(program.id);
    if (!row || row.market !== market) {
      return { ...program, shadowBookSnapshot: { state: "none" as const, note: "No forward paired-book P&L snapshot has been captured for this program." } };
    }
    return {
      ...program,
      shadowBookSnapshot: {
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
      },
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
    },
    market,
    snapshotLedger,
    programs: programsWithSnapshots,
  });
}
