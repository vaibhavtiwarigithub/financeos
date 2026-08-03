import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { screenerFieldContract } from "@/lib/data/yahoo-screener";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Field-contract check for the Yahoo custom screener.
//
// The screener is an undocumented endpoint. A criterion can be accepted by the
// API and silently discarded: no error, no exception, no failing test — the
// screen keeps returning names while the bucket quietly widens to whatever the
// surviving legs allow. `freecashflow.lasttwelvemonths` is already in that state,
// which is why it is not in any shipped bucket.
//
// The only reliable detector is an absurd-value probe: set a threshold nothing
// can satisfy and confirm the count collapses against the same bucket minus that
// one criterion. Daily is enough — this changes on the provider's deploy cadence.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();

  const results = await screenerFieldContract();
  const probed = results.filter(r => r.baseline !== null && r.absurd !== null);
  const degraded = results.filter(r => !r.honoured);

  for (const r of degraded) {
    await reportIssue({
      issueKey: `screener-field-degraded:${r.field}`,
      severity: "critical",
      category: "data_provider",
      title: `Yahoo screener criterion '${r.field}' no longer filters`,
      detail: `An absurd threshold on '${r.field}' returned ${r.absurd} names against a baseline of ${r.baseline} for the same bucket without it. The provider is accepting the criterion and discarding it, so that bucket is now wider than its stated definition without any error. US discovery should fall back to FinancialDatasets until the field is replaced or removed from the bucket.`,
    }, svc);
  }
  // Only clear a field we actually re-probed. A failed probe is not evidence of
  // health, and auto-resolving on it would silence a real degradation.
  for (const r of probed.filter(x => x.honoured)) {
    await resolveIssue(`screener-field-degraded:${r.field}`, svc);
  }

  return NextResponse.json({
    success: true,
    checked: results.length,
    probed: probed.length,
    degraded: degraded.map(r => r.field),
    results,
  });
}
