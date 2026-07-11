import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { runAutonomousLive } from "@/lib/trading/autonomous-live";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const runId = randomUUID();
  // Per-market scheduling: US and India crons run at their own exchange sessions.
  const marketParam = req.nextUrl.searchParams.get("market");
  const marketFilter = marketParam === "us" || marketParam === "india" ? marketParam : undefined;

  try {
    const result = await runAutonomousLive(svc, runId, marketFilter);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "unknown", run_id: runId },
      { status: 500 },
    );
  }
}
