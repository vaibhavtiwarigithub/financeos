import { NextResponse } from "next/server";

// RETIRED (live-trading-hardening P1, 2026-07-07).
// Proposal rejection is consolidated onto /api/agents/trader (action:"reject",
// proposal_id) operating on the canonical trade_proposals table. This legacy
// route rejected rows in the parallel trade_queue table and is removed.
export async function POST() {
  return NextResponse.json({
    error: "Retired endpoint. Reject proposals via POST /api/agents/trader with { action: 'reject', proposal_id }.",
    use_instead: "/api/agents/trader",
  }, { status: 410 });
}
