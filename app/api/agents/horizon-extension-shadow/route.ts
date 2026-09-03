// POST/GET /api/agents/horizon-extension-shadow?market=us|india
//
// Records what the conditional horizon-extension policy WOULD have decided for
// every open paper position. Measure-only: it never closes, holds, sizes, or
// touches a position, and no exit path reads its output.
//
// Gated like the other shadow agents: CRON_SECRET for the scheduled run, or the
// owner for a manual run. GET is a dry run that returns verdicts without writing,
// so the policy can be inspected before it starts accumulating a ledger.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { runHorizonExtensionShadow } from "@/lib/trading/horizon-extension-shadow";
import { matureTimeReviewOutcomes } from "@/lib/trading/time-review-shadow";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function marketParam(req: NextRequest): "us" | "india" | undefined {
  const m = req.nextUrl.searchParams.get("market");
  return m === "us" || m === "india" ? m : undefined;
}

async function authorize(req: NextRequest): Promise<NextResponse | null> {
  if (verifyCronSecret(req)) return null;
  return requireOwner();
}

/** Summarise verdicts so a run is readable without paging through every row. */
function summarize(rows: Awaited<ReturnType<typeof runHorizonExtensionShadow>>["rows"]) {
  const byReason: Record<string, number> = {};
  const blockedBy: Record<string, number> = {};
  for (const r of rows) {
    byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    for (const f of r.failed) blockedBy[f] = (blockedBy[f] ?? 0) + 1;
  }
  const atCheckpoint = rows.filter(r => r.reason !== "not_at_checkpoint");
  return {
    evaluated: rows.length,
    at_checkpoint: atCheckpoint.length,
    would_extend: rows.filter(r => r.extend).length,
    by_reason: byReason,
    // Which condition blocks most often — the first thing worth knowing, because
    // a policy blocked entirely by missing evidence is measuring plumbing, not
    // the question it was built to answer.
    blocked_by: Object.fromEntries(Object.entries(blockedBy).sort((a, b) => b[1] - a[1])),
  };
}

export async function GET(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return denied;
  const svc = createServiceClient();
  const { rows, runId } = await runHorizonExtensionShadow(svc, { market: marketParam(req), persist: false });
  return NextResponse.json({ dry_run: true, run_id: runId, ...summarize(rows), rows });
}

export async function POST(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return denied;
  const svc = createServiceClient();
  const market = marketParam(req);
  // Preserve the v0 daily counterfactual as frozen historical context while
  // the same scheduled job matures the approved exact-review v1 outcomes.
  const result = await runHorizonExtensionShadow(svc, { market });
  const maturation = await matureTimeReviewOutcomes(svc, market ?? null);
  return NextResponse.json({
    dry_run: false,
    run_id: result.runId,
    // false means the ledger table is not there yet (migration
    // 20260811150000_horizon_extension_shadow.sql), not that the run failed.
    persisted: result.persisted,
    time_review_maturation: maturation,
    ...summarize(result.rows),
  });
}
