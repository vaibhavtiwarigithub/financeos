import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { fetchFiiDiiFlows, fiiDiiMacroLine } from "@/lib/india-macro";

export const dynamic = "force-dynamic";

// Read-only FII/DII net cash-flow feed (NSE). Owner-gated. Serves two purposes:
//   1. surfaces India FII/DII flows for a future India-macro UI, and
//   2. lets us verify from the deployed (Vercel) environment whether NSE responds
//      there — NSE geo-throttles some datacenter IPs, so `sessions` may be null on
//      Vercel even though it works locally. `reachable` makes that explicit.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const sessions = await fetchFiiDiiFlows();
  return NextResponse.json({
    reachable: sessions !== null,
    macroLine: fiiDiiMacroLine(sessions),
    sessions: sessions ?? [],
    note: sessions === null
      ? "NSE did not respond from this environment (likely geo-throttled). India research falls back to the US/global macro backdrop — no fabricated flow values."
      : "Live NSE FII/DII net cash-segment flows (₹ crore).",
  });
}
