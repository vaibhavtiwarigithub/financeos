import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Safe-P3 watchdog — janitor for the agent pipeline. Read-mostly + bounded
// status corrections only; never touches money, positions, ledgers, or config.
//
// Every Vercel function is capped at maxDuration (<= ~160s), so ANY agent_runs
// row still 'running' after 15 minutes is a zombie: the function died without
// finalizing. Likewise a signal stuck in 'claiming' past 15 minutes means the
// paper-trade run that claimed it died mid-flight (its owner-safe revert never
// ran). And pending long signals older than the current market-local trading
// day can never fill (freshness guard) — expire them so they stop accumulating.
//
// Idempotent: safe to run on any cadence; a clean pipeline makes zero changes.

const ZOMBIE_RUN_MIN = 15;      // 'running' longer than this = dead function
const STUCK_CLAIM_MIN = 15;     // 'claiming' longer than this = orphaned claim

export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const nowIso = new Date().toISOString();
  const runCutoff = new Date(Date.now() - ZOMBIE_RUN_MIN * 60_000).toISOString();
  const claimCutoff = new Date(Date.now() - STUCK_CLAIM_MIN * 60_000).toISOString();

  // 1) Reap zombie agent_runs: still 'running' well past any function's max life.
  const { data: reapedRuns } = await svc
    .from("agent_runs")
    .update({ status: "error", completed_at: nowIso, result_summary: "Reaped by watchdog — run never finalized (function died / timed out)." })
    .eq("status", "running")
    .lt("started_at", runCutoff)
    .select("id");

  // 2) Revert orphaned 'claiming' signals back to 'pending' and clear the claim
  //    stamps, so the next paper-trade run can pick them up.
  const { data: revertedClaims } = await svc
    .from("agent_signals")
    .update({ status: "pending", claim_run_id: null, claimed_at: null })
    .eq("status", "claiming")
    .lt("claimed_at", claimCutoff)
    .select("id");

  // 3) Expire stale pending signals per market (older than today's market-local
  //    open). Only fresh LONG signals are fill-eligible, so any stale pending —
  //    long, neutral, or short — can never fill and is inert clutter. Expiring
  //    all directions keeps the signal table clean (neutral/short otherwise
  //    accumulate as 'pending' forever, since the old long-only filter left them).
  const expiredByMarket: Record<string, number> = {};
  for (const market of ["us", "india"] as const) {
    const { data: cutoff } = await svc.rpc("market_trading_day_start", { p_market: market });
    if (!cutoff) continue;
    const { data: expired } = await svc
      .from("agent_signals")
      .update({ status: "expired" })
      .eq("status", "pending").eq("market", market)
      .lt("created_at", cutoff as unknown as string)
      .select("id");
    expiredByMarket[market] = expired?.length ?? 0;
  }

  const result = {
    ok: true,
    reapedRuns: reapedRuns?.length ?? 0,
    revertedClaims: revertedClaims?.length ?? 0,
    expiredPending: expiredByMarket,
    at: nowIso,
  };

  // Record the janitor pass so it shows in the agents list like any other run.
  await svc.from("agent_runs").insert({
    agent_type: "watchdog", status: "done", trigger_source: isCron ? "scheduled" : "manual",
    signals_written: 0, completed_at: nowIso,
    result_summary: `Watchdog: reaped ${result.reapedRuns} zombie run(s), reverted ${result.revertedClaims} stuck claim(s), expired ${Object.values(expiredByMarket).reduce((a, b) => a + b, 0)} stale pending.`,
  } as any).select("id").maybeSingle().then(() => {}, () => {});

  return NextResponse.json(result);
}

export async function GET() {
  return NextResponse.json({ message: "POST to run the watchdog (cron or owner)." });
}
