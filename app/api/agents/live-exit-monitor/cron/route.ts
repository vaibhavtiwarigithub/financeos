import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { runLiveExitMonitor } from "@/lib/trading/live-exit-monitor";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Protective-exit monitor for LIVE positions (R16). Runs frequently during the
// US session; sells a live position through the hardened gateway when a stop /
// target / time trigger fires. No-op unless the live-auto system is armed.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const runId = randomUUID();
  try {
    const result = await runLiveExitMonitor(svc, runId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "unknown", run_id: runId }, { status: 500 });
  }
}
