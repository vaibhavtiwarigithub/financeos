import { NextResponse } from "next/server";

// RETIRED (live-trading-hardening P1, 2026-07-07).
// Proposal approval is consolidated onto /api/agents/trader (action:"approve",
// proposal_id) operating on the canonical trade_proposals table — which runs the
// full gate set (kill switches, account allowlist, expiry, drift). This legacy
// route approved rows in the parallel trade_queue table and is removed.
export async function POST() {
  return NextResponse.json({
    error: "Retired endpoint. Approve proposals via POST /api/agents/trader with { action: 'approve', proposal_id }.",
    use_instead: "/api/agents/trader",
  }, { status: 410 });
}
