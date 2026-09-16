// POST /api/cron/warm-market-snapshot
// Calls the overview route (which writes to market_overview_snapshots) so
// viewers never trigger a live Massive provider call.
// Scheduled daily at ~16:15 ET after market close via pg_cron.
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET ?? "";

  const res = await fetch(`${base}/api/markets/overview`, {
    headers: { "x-cron-secret": secret },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return NextResponse.json({ ok: false, reason: body.degraded ?? `HTTP ${res.status}` });
  }

  const data = await res.json();
  return NextResponse.json({
    ok: !data.degraded,
    sessionDate: data.sessionDate ?? null,
    stale: data.stale ?? true,
    degraded: data.degraded ?? null,
  });
}
