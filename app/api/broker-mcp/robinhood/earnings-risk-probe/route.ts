import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getQuote } from "@/lib/data/quotes";
import { annotateEarningsRisk, recordEarningsRiskObservation } from "@/lib/risk/earnings-risk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Bounded, read-only contract probe. It uses one liquid US symbol and persists
// only the normalized event/straddle result; raw broker chain payloads are never
// stored or returned.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const supabase = createServiceClient();
  const symbol = "AAPL";
  const quote = await getQuote(symbol, supabase);
  if (quote.source === "unavailable" || quote.price <= 0) {
    return NextResponse.json({ error: "probe_spot_unavailable" }, { status: 503 });
  }
  const annotation = await annotateEarningsRisk({
    supabase,
    symbol,
    market: "us",
    horizonSessions: 31,
    spot: quote.price,
    stopDistancePct: 0.07,
  });
  await recordEarningsRiskObservation(supabase, {
    environment: "probe",
    decisionKind: "contract_probe",
    annotation,
  });
  return NextResponse.json({
    symbol,
    spotSource: quote.source,
    annotation,
  });
}
