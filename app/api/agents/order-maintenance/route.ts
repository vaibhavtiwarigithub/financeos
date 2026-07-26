import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { cancelStaleOrders, reconcileUnknownOrders } from "@/lib/trading/order-maintenance";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Cron: every 30 min — cancel pending_submit/submitted orders stuck >30 min,
// then reconcile unknown_needs_reconcile rows by polling Robinhood order status.
async function run() {
  const svc = createServiceClient();
  const [cancelResult, reconcileResult] = await Promise.all([
    cancelStaleOrders(svc),
    reconcileUnknownOrders(svc),
  ]);
  return {
    ok: true,
    cancelled: cancelResult.cancelled,
    reconciled: reconcileResult.resolved,
    errors: cancelResult.errors + reconcileResult.errors,
    ranAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const authError = await requireOwner();
    if (authError) return authError;
  }
  return NextResponse.json(await run());
}

export const POST = GET;
