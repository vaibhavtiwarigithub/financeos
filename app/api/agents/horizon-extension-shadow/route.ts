// Retired endpoint: the hypothetical next-session-sale baseline no longer
// matches the current exit policy. Respond 200/paused during schedule retirement
// so a still-installed pg_cron job does not accumulate invalid evidence or log a
// false transport failure. P0 exact-horizon observations remain in PositionMonitor.
import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function authorize(req: NextRequest): Promise<NextResponse | null> {
  if (verifyCronSecret(req)) return null;
  return requireOwner();
}

function retiredResponse() {
  const reason = "The unconditional time stop was removed on 2026-09-10, so the next-session-sale versus extension comparator is retired. Exact-horizon P0 observations are recorded by PositionMonitor; historical comparator rows remain immutable and no new rows are written.";
  return NextResponse.json({
    retired: true,
    status: "paused",
    persisted: false,
    time_review_maturation: { status: "paused", reason },
    reason,
  });
}

export async function GET(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return denied;
  return retiredResponse();
}

export async function POST(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return denied;
  return retiredResponse();
}
