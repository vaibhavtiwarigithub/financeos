import { NextResponse } from "next/server";
import { fetchNseFiiDii, fetchNseBigDeals } from "@/lib/nse-data";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// India "smart money" — FII/DII institutional flows + block/bulk deals. The
// India analog to the US Congress/insider smart-money feeds (India has no
// politician-trade disclosure). Advisory only. Fails soft: NSE's cookie-gated
// endpoints can block non-India IPs, so an empty result is a normal degraded
// state, not an error.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const [fiiDii, bigDeals] = await Promise.all([
    fetchNseFiiDii().catch(() => []),
    fetchNseBigDeals().catch(() => []),
  ]);

  const fii = fiiDii.find(f => /fii|foreign/i.test(f.category));
  const dii = fiiDii.find(f => /dii|domestic/i.test(f.category));
  // Net institutional tone for the session: both buying = risk-on, both selling
  // = risk-off. Advisory read only.
  const netTone =
    fii && dii
      ? (fii.net > 0 && dii.net > 0 ? "risk-on (both buying)"
        : fii.net < 0 && dii.net < 0 ? "risk-off (both selling)"
        : "mixed (FII/DII diverging)")
      : "unavailable";

  return NextResponse.json({
    fii_dii: fiiDii,
    net_tone: netTone,
    big_deals: bigDeals,
    counts: { fii_dii: fiiDii.length, big_deals: bigDeals.length },
    available: fiiDii.length > 0 || bigDeals.length > 0,
    as_of: new Date().toISOString(),
  });
}
