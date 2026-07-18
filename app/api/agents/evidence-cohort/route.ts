import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { isMarket, type Market } from "@/lib/evidence/contracts";
import { buildAndPersistCohort } from "@/lib/evidence/evaluation/cohort-builder";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Canonical Evidence Router — COHORT BUILDER run (router-cutover §4.2, shadow only).
//
// Resolves recent REAL research decisions for a market into a frozen dual-run
// cohort, scores BOTH legs with the production scorer, and persists the result to
// evidence_policy_evaluations (+ evidence_evaluation_details). router_enabled
// stays false: this NEVER feeds scoring, signals, sizing, cash, positions, or
// orders. It only produces the parity evaluations the future cutover is gated on.
//
// The build reuses ONE frozen observation set for both the candidate and the
// reverse-shadow leg, and reports the provider_call_ledger proof that the
// reverse leg made no new provider burst (§4.2).
//
// GET is cron-only; POST is owner- or cron-gated.

async function runCohort(req: NextRequest, ownerAllowed: boolean) {
  if (!verifyCronSecret(req)) {
    if (!ownerAllowed) return NextResponse.json({ error: "cron authentication required for GET" }, { status: 401 });
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const marketParam = req.nextUrl.searchParams.get("market") ?? "us";
  if (!isMarket(marketParam)) {
    return NextResponse.json({ error: `invalid market '${marketParam}'` }, { status: 400 });
  }
  const market: Market = marketParam;
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "25") || 25));
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  try {
    const report = await buildAndPersistCohort({ market, limit, dryRun });
    return NextResponse.json({
      ok: true,
      ranAt: new Date().toISOString(),
      shadowOnly: true,
      note: "router_enabled=false; evaluation persisted to evidence_policy_evaluations, never scored/traded",
      ...report,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, market, error: err instanceof Error ? err.message : "cohort build failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return runCohort(req, false);
}

export async function POST(req: NextRequest) {
  return runCohort(req, true);
}
