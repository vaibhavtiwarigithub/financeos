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
  const probed = results.filter(r => r.probed);
  const unprobed = results.filter(r => !r.probed);
  const degraded = probed.filter(r => !r.honoured);

  // An unreachable provider is its own condition and must be visible. Silence
  // here previously meant "no degradation found", which a total Yahoo outage
  // satisfied trivially — the check would pass loudest exactly when it knew
  // least. If nothing could be probed, the contract is UNVERIFIED, not clean.
  if (unprobed.length === results.length && results.length > 0) {
    await reportIssue({
      issueKey: "screener-contract-unverifiable",
      severity: "warn",
      category: "data_provider",
      title: "Yahoo screener field contract could not be verified",
      detail: `None of the ${results.length} criteria could be probed — every request failed to return a count, which usually means the crumb handshake or the endpoint itself is unreachable from this environment. This is NOT a clean bill of health: a criterion could have silently stopped filtering and this run would not know. If US discovery is also producing no candidates, treat the endpoint as down and rely on the FinancialDatasets fallback until a probe succeeds.`,
    }, svc);
  } else {
    await resolveIssue("screener-contract-unverifiable", svc);
  }

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
    // Named so a caller cannot read "degraded: []" as "everything is fine"
    // without also seeing how many criteria were actually verified.
    unverified: unprobed.map(r => r.field),
    degraded: degraded.map(r => r.field),
    verdict: results.length === 0 ? "no_criteria"
      : probed.length === 0 ? "unverifiable"
      : degraded.length > 0 ? "degraded"
      : unprobed.length > 0 ? "partially_verified"
      : "verified",
    results,
  });
}
