import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { runLiveExitMonitor } from "@/lib/trading/live-exit-monitor";
import { classifyLiveExitCollection, liveExitProducerRunTimestamps, type LiveExitMarketDiagnostics } from "@/lib/trading/live-exit-shadow-health";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function persistProducerHealth(
  svc: ReturnType<typeof createServiceClient>,
  runId: string,
  startedAt: Date,
  diagnostics: LiveExitMarketDiagnostics[],
): Promise<boolean> {
  const writes = await Promise.all(diagnostics.map(async (run) => {
    const outcome = classifyLiveExitCollection(run);
    const timestamps = liveExitProducerRunTimestamps(startedAt, new Date());
    try {
      const { error } = await svc.from("upgrade_path_producer_runs").insert({
        program_id: "live-exit-ladder-parity",
        market: run.market,
        run_key: `${runId}:${run.market}`,
        trigger_source: "cron_authenticated",
        status: outcome.status,
        code_version: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        ...timestamps,
        blockers: outcome.blockers,
        details: { collectionState: outcome.state, ...run },
      });
      if (error) throw error;
      return true;
    } catch (error: any) {
      // Health telemetry is deliberately best-effort and happens after the
      // monitor has completed; it must never gate or repeat an exit operation.
      console.error("[live-exit-producer-health] persistence failed", run.market, error?.code ?? "unknown");
      return false;
    }
  }));
  return writes.every(Boolean);
}

async function persistInvocationError(svc: ReturnType<typeof createServiceClient>, runId: string, startedAt: Date): Promise<boolean> {
  const writes = await Promise.all((["us", "india"] as const).map(async (market) => {
    const timestamps = liveExitProducerRunTimestamps(startedAt, new Date());
    try {
      const { error } = await svc.from("upgrade_path_producer_runs").insert({
        program_id: "live-exit-ladder-parity",
        market,
        run_key: `${runId}:${market}`,
        trigger_source: "cron_authenticated",
        status: "error",
        code_version: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        ...timestamps,
        blockers: ["The monitor invocation failed before a complete market diagnostic was returned."],
        details: { collectionState: "monitor_invocation_error" },
      });
      if (error) throw error;
      return true;
    } catch (error: any) {
      console.error("[live-exit-producer-health] error persistence failed", market, error?.code ?? "unknown");
      return false;
    }
  }));
  return writes.every(Boolean);
}

// Protective-exit monitor for LIVE positions (R16). Runs frequently during the
// US session; sells a live position through the hardened gateway when a stop /
// target / time trigger fires. No-op unless the live-auto system is armed.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const runId = randomUUID();
  const startedAt = new Date();
  try {
    const result = await runLiveExitMonitor(svc, runId);
    const producerHealthPersisted = await persistProducerHealth(svc, runId, startedAt, result.market_runs);
    return NextResponse.json({ ok: true, ...result, producer_health_persisted: producerHealthPersisted });
  } catch (err: any) {
    const producerHealthPersisted = await persistInvocationError(svc, runId, startedAt);
    return NextResponse.json({ ok: false, error: err?.message ?? "unknown", run_id: runId, producer_health_persisted: producerHealthPersisted }, { status: 500 });
  }
}
